import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { customers } from "./customers.js";
import { locations } from "./locations.js";
import { productVariants } from "./productVariants.js";
import { products } from "./products.js";
import { saleItems } from "./saleItems.js";
import { sales } from "./sales.js";
import { serialNumbers } from "./serialNumbers.js";
import { users } from "./users.js";

/**
 * Warranty management (migration 0064).
 *
 * Two separate but connected systems:
 * - Product/variant warranty CONFIGURATION (this file, `product_warranty_configs`)
 *   resolved variant-row → product-row → none. Follows the
 *   product_unit_conversions override pattern: variantId NULL = product default.
 * - CUSTOMER warranties issued at sale completion + their CLAIMS. Terms are
 *   snapshotted on every issued warranty so history never depends on current
 *   product configuration. Expired is DERIVED from expiry_date (never stored);
 *   stored statuses describe the lifecycle only.
 *
 * Supplier warranties live in supplierWarranties.ts (separate subsystem).
 */

export const productWarrantyConfigs = pgTable(
  "product_warranty_configs",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    productId: integer("product_id").notNull(),
    /** NULL = product-level default; set = variant-specific override. */
    variantId: integer("variant_id"),
    /** A variant row with enabled=false explicitly opts that variant out. */
    enabled: boolean("enabled").notNull().default(true),
    provider: varchar("provider", { length: 30 }).notNull().default("manufacturer"),
    warrantyType: varchar("warranty_type", { length: 30 })
      .notNull()
      .default("comprehensive"),
    duration: integer("duration").notNull(),
    durationUnit: varchar("duration_unit", { length: 10 }).notNull().default("months"),
    terms: text("terms"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "product_warranty_configs_provider_check",
      sql`${table.provider} IN ('manufacturer','seller','distributor','supplier','third_party')`,
    ),
    check(
      "product_warranty_configs_type_check",
      sql`${table.warrantyType} IN ('repair','replacement','service','limited','parts_only','comprehensive')`,
    ),
    check(
      "product_warranty_configs_unit_check",
      sql`${table.durationUnit} IN ('days','months','years')`,
    ),
    check(
      "product_warranty_configs_duration_check",
      sql`${table.duration} > 0`,
    ),
    check(
      "product_warranty_configs_status_check",
      sql`${table.status} IN ('active','inactive')`,
    ),
    unique("product_warranty_configs_id_business_uq").on(
      table.id,
      table.businessId,
    ),
    uniqueIndex("product_warranty_configs_product_variant_uq").on(
      table.productId,
      sql`COALESCE(${table.variantId}, 0)`,
    ),
    index("product_warranty_configs_business_idx").on(table.businessId),
    index("product_warranty_configs_product_idx").on(table.productId),
    foreignKey({
      columns: [table.productId, table.businessId],
      foreignColumns: [products.id, products.businessId],
      name: "product_warranty_configs_product_business_fkey",
    }),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "product_warranty_configs_variant_business_fkey",
    }),
  ],
);

/**
 * A warranty issued to a customer when a sale completes. ONE row per sold
 * serial for serial-tracked products (serialId set, quantity=1); ONE row per
 * sale item otherwise (serialId NULL, quantity = line quantity, maintained
 * returnedQuantity). All warranty terms are snapshots taken at generation.
 */
export const customerWarranties = pgTable(
  "customer_warranties",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    locationId: integer("location_id").notNull(),
    warrantyNumber: varchar("warranty_number", { length: 30 }).notNull(),
    saleId: integer("sale_id").notNull(),
    saleItemId: integer("sale_item_id").notNull(),
    /** NULL = walk-in sale. */
    customerId: integer("customer_id"),
    productId: integer("product_id").notNull(),
    variantId: integer("variant_id").notNull(),
    serialId: integer("serial_id"),
    /** Snapshot of serial_numbers.serial_number at generation. */
    serialNumber: varchar("serial_number", { length: 100 }),
    /** Units covered by this row (1 for serial-scoped rows). */
    quantity: integer("quantity").notNull().default(1),
    /** Units already returned under partial refunds (0 initially). 0078:
     * double precision — fractional sold-by-weight returns must not round. */
    returnedQuantity: doublePrecision("returned_quantity").notNull().default(0),
    // --- warranty terms snapshot (never re-read from product config) ---
    provider: varchar("provider", { length: 30 }).notNull(),
    warrantyType: varchar("warranty_type", { length: 30 }).notNull(),
    duration: integer("duration").notNull(),
    durationUnit: varchar("duration_unit", { length: 10 }).notNull(),
    terms: text("terms"),
    /** The sale's business-effective date (sale_date), not the claim date. */
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    expiryDate: timestamp("expiry_date", { withTimezone: true }).notNull(),
    /** Lifecycle status; expired is derived by comparing expiry_date to now. */
    status: varchar("status", { length: 20 }).notNull().default("active"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: varchar("void_reason", { length: 200 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "customer_warranties_status_check",
      sql`${table.status} IN ('active','voided','replaced','suspended')`,
    ),
    unique("customer_warranties_id_business_uq").on(table.id, table.businessId),
    uniqueIndex("customer_warranties_number_business_uq").on(
      table.businessId,
      table.warrantyNumber,
    ),
    // Duplicate-proof generation: at most one quantity-based warranty per
    // sale item, at most one warranty per serial — retries and code-path
    // changes cannot create a second row.
    uniqueIndex("customer_warranties_sale_item_uq")
      .on(table.saleItemId)
      .where(sql`${table.serialId} IS NULL`),
    uniqueIndex("customer_warranties_serial_uq")
      .on(table.serialId)
      .where(sql`${table.serialId} IS NOT NULL`),
    index("customer_warranties_business_status_idx").on(
      table.businessId,
      table.status,
    ),
    index("customer_warranties_expiry_idx").on(
      table.businessId,
      table.expiryDate,
    ),
    index("customer_warranties_customer_idx").on(
      table.businessId,
      table.customerId,
    ),
    index("customer_warranties_sale_idx").on(table.businessId, table.saleId),
    index("customer_warranties_product_idx").on(
      table.businessId,
      table.productId,
      table.variantId,
    ),
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "customer_warranties_location_business_fkey",
    }),
    foreignKey({
      columns: [table.saleId, table.businessId],
      foreignColumns: [sales.id, sales.businessId],
      name: "customer_warranties_sale_business_fkey",
    }),
    foreignKey({
      columns: [table.saleItemId, table.businessId],
      foreignColumns: [saleItems.id, saleItems.businessId],
      name: "customer_warranties_sale_item_business_fkey",
    }),
    // customers / serial_numbers have no (id, business_id) candidate key —
    // plain FKs, matching the sales.customerId precedent. The businessId
    // scope is still enforced in every query and by the other composite FKs.
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [customers.id],
      name: "customer_warranties_customer_fkey",
    }),
    foreignKey({
      columns: [table.productId, table.businessId],
      foreignColumns: [products.id, products.businessId],
      name: "customer_warranties_product_business_fkey",
    }),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "customer_warranties_variant_business_fkey",
    }),
    foreignKey({
      columns: [table.serialId],
      foreignColumns: [serialNumbers.id],
      name: "customer_warranties_serial_fkey",
    }),
  ],
);

/**
 * A customer warranty claim. Lifecycle transitions are enforced by the
 * claim service (transition map), never by the DB. "Expired"/"voided"
 * eligibility is validated in the service against the parent warranty.
 */
export const warrantyClaims = pgTable(
  "warranty_claims",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    locationId: integer("location_id").notNull(),
    claimNumber: varchar("claim_number", { length: 30 }).notNull(),
    warrantyId: integer("warranty_id").notNull(),
    // Denormalized for list speed; always consistent with the parent row.
    customerId: integer("customer_id"),
    productId: integer("product_id").notNull(),
    variantId: integer("variant_id").notNull(),
    serialId: integer("serial_id"),
    serialNumber: varchar("serial_number", { length: 100 }),
    claimType: varchar("claim_type", { length: 30 }).notNull().default("repair"),
    status: varchar("status", { length: 30 }).notNull().default("submitted"),
    resolutionType: varchar("resolution_type", { length: 30 }),
    reportedProblem: text("reported_problem").notNull(),
    inspectionNotes: text("inspection_notes"),
    assignedUserId: integer("assigned_user_id"),
    receivedDate: timestamp("received_date", { withTimezone: true }),
    resolvedDate: timestamp("resolved_date", { withTimezone: true }),
    closedDate: timestamp("closed_date", { withTimezone: true }),
    // Repair record
    repairDescription: text("repair_description"),
    partsUsed: text("parts_used"),
    repairCost: numeric("repair_cost", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    // Replacement record
    replacementVariantId: integer("replacement_variant_id"),
    replacementSerialNumber: varchar("replacement_serial_number", {
      length: 100,
    }),
    replacementDate: timestamp("replacement_date", { withTimezone: true }),
    /** Warranty issued for the replacement unit (inherits original expiry). */
    newWarrantyId: integer("new_warranty_id"),
    pickupDate: timestamp("pickup_date", { withTimezone: true }),
    resolutionNotes: text("resolution_notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "warranty_claims_type_check",
      sql`${table.claimType} IN ('repair','replacement','parts_replacement','service')`,
    ),
    check(
      "warranty_claims_status_check",
      sql`${table.status} IN ('submitted','under_inspection','approved','rejected','repairing','waiting_parts','ready_for_pickup','replaced','closed','cancelled')`,
    ),
    check(
      "warranty_claims_resolution_check",
      sql`${table.resolutionType} IS NULL OR ${table.resolutionType} IN ('repair','replacement','parts_replacement','service','rejected')`,
    ),
    check(
      "warranty_claims_repair_cost_check",
      sql`${table.repairCost} >= (0)::numeric`,
    ),
    unique("warranty_claims_id_business_uq").on(table.id, table.businessId),
    uniqueIndex("warranty_claims_number_business_uq").on(
      table.businessId,
      table.claimNumber,
    ),
    index("warranty_claims_business_status_idx").on(table.businessId, table.status),
    index("warranty_claims_warranty_idx").on(table.businessId, table.warrantyId),
    index("warranty_claims_assigned_idx").on(
      table.businessId,
      table.assignedUserId,
    ),
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "warranty_claims_location_business_fkey",
    }),
    foreignKey({
      columns: [table.warrantyId, table.businessId],
      foreignColumns: [customerWarranties.id, customerWarranties.businessId],
      name: "warranty_claims_warranty_business_fkey",
    }),
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [customers.id],
      name: "warranty_claims_customer_fkey",
    }),
    foreignKey({
      columns: [table.productId, table.businessId],
      foreignColumns: [products.id, products.businessId],
      name: "warranty_claims_product_business_fkey",
    }),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "warranty_claims_variant_business_fkey",
    }),
    // users is global (no businessId column) — plain FK like
    // warranty_claim_events.actor_user_id.
    foreignKey({
      columns: [table.assignedUserId],
      foreignColumns: [users.id],
      name: "warranty_claims_assigned_user_fkey",
    }),
  ],
);

/**
 * Append-only claim history (clone of the sale_order_events pattern). Rows
 * are never updated or deleted; every transition, note and resolution
 * records one row.
 */
export const warrantyClaimEvents = pgTable(
  "warranty_claim_events",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    claimId: integer("claim_id").notNull(),
    warrantyId: integer("warranty_id").notNull(),
    eventType: varchar("event_type", { length: 40 }).notNull(),
    previousStatus: varchar("previous_status", { length: 30 }),
    newStatus: varchar("new_status", { length: 30 }),
    /** user | system */
    actorType: varchar("actor_type", { length: 20 })
      .default("user")
      .notNull(),
    actorUserId: integer("actor_user_id").references(() => users.id),
    actorLabel: varchar("actor_label", { length: 120 }),
    note: text("note"),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.claimId, table.businessId],
      foreignColumns: [warrantyClaims.id, warrantyClaims.businessId],
      name: "warranty_claim_events_claim_business_fkey",
    }),
    index("warranty_claim_events_claim_created_idx").on(
      table.claimId,
      table.createdAt,
    ),
    index("warranty_claim_events_business_idx").on(table.businessId),
  ],
);
