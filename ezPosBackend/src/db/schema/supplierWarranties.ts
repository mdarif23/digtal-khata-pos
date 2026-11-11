import { sql } from "drizzle-orm";
import {
  check,
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
import { inventoryBatches } from "./inventoryBatches.js";
import { locations } from "./locations.js";
import { productVariants } from "./productVariants.js";
import { products } from "./products.js";
import { purchaseItems } from "./purchaseItems.js";
import { purchases } from "./purchases.js";
import { suppliers } from "./suppliers.js";
import { users } from "./users.js";
import { warrantyClaims } from "./warranties.js";

/**
 * Supplier warranty subsystem (migration 0064) — deliberately SEPARATE from
 * customer warranties/claims so the shop can measure its own warranty
 * expense and the supplier's recovery independently.
 *
 * ONE supplier_warranties row per purchase item (unique purchase_item_id —
 * receive-capture and retroactive manual entry cannot duplicate); defective
 * serials are identified at claim time, not per-serial rows.
 */
export const supplierWarranties = pgTable(
  "supplier_warranties",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    supplierId: integer("supplier_id").notNull(),
    purchaseId: integer("purchase_id").notNull(),
    purchaseItemId: integer("purchase_item_id").notNull(),
    productId: integer("product_id").notNull(),
    variantId: integer("variant_id").notNull(),
    batchId: integer("batch_id"),
    provider: varchar("provider", { length: 30 }).notNull().default("supplier"),
    duration: integer("duration").notNull(),
    durationUnit: varchar("duration_unit", { length: 10 }).notNull().default("months"),
    terms: text("terms"),
    /** Received units covered by this warranty. */
    quantity: integer("quantity").notNull().default(0),
    /** Units already written into supplier claims (defective/replaced). */
    claimedQuantity: integer("claimed_quantity").notNull().default(0),
    /** First receive date of the purchase item — never the claim date. */
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    expiryDate: timestamp("expiry_date", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    /** receive = captured during receiving; manual = retroactive entry. */
    source: varchar("source", { length: 20 }).notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "supplier_warranties_status_check",
      sql`${table.status} IN ('active','voided','exhausted')`,
    ),
    check(
      "supplier_warranties_source_check",
      sql`${table.source} IN ('receive','manual')`,
    ),
    check(
      "supplier_warranties_unit_check",
      sql`${table.durationUnit} IN ('days','months','years')`,
    ),
    check(
      "supplier_warranties_duration_check",
      sql`${table.duration} > 0`,
    ),
    unique("supplier_warranties_id_business_uq").on(table.id, table.businessId),
    uniqueIndex("supplier_warranties_purchase_item_uq").on(table.purchaseItemId),
    index("supplier_warranties_business_status_idx").on(
      table.businessId,
      table.status,
    ),
    index("supplier_warranties_expiry_idx").on(
      table.businessId,
      table.expiryDate,
    ),
    index("supplier_warranties_supplier_idx").on(
      table.businessId,
      table.supplierId,
    ),
    foreignKey({
      columns: [table.supplierId, table.businessId],
      foreignColumns: [suppliers.id, suppliers.businessId],
      name: "supplier_warranties_supplier_business_fkey",
    }),
    foreignKey({
      columns: [table.purchaseId, table.businessId],
      foreignColumns: [purchases.id, purchases.businessId],
      name: "supplier_warranties_purchase_business_fkey",
    }),
    foreignKey({
      columns: [table.purchaseItemId, table.businessId],
      foreignColumns: [purchaseItems.id, purchaseItems.businessId],
      name: "supplier_warranties_item_business_fkey",
    }),
    foreignKey({
      columns: [table.productId, table.businessId],
      foreignColumns: [products.id, products.businessId],
      name: "supplier_warranties_product_business_fkey",
    }),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "supplier_warranties_variant_business_fkey",
    }),
    foreignKey({
      columns: [table.batchId, table.businessId],
      foreignColumns: [inventoryBatches.id, inventoryBatches.businessId],
      name: "supplier_warranties_batch_business_fkey",
    }),
  ],
);

/**
 * A claim against a supplier for defective purchased goods. Tracks the
 * supplier's repair/replacement response and the value recovered from the
 * supplier — completely separate from customer warranty claims.
 */
export const supplierWarrantyClaims = pgTable(
  "supplier_warranty_claims",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    locationId: integer("location_id").notNull(),
    claimNumber: varchar("claim_number", { length: 30 }).notNull(),
    supplierWarrantyId: integer("supplier_warranty_id").notNull(),
    supplierId: integer("supplier_id").notNull(),
    purchaseId: integer("purchase_id").notNull(),
    productId: integer("product_id").notNull(),
    variantId: integer("variant_id").notNull(),
    /** Optional traceability link to the customer claim that spawned this. */
    customerWarrantyClaimId: integer("customer_warranty_claim_id"),
    defectiveQuantity: integer("defective_quantity").notNull(),
    /** Serial ids sent back to the supplier, when serial-tracked. */
    serialIds: jsonb("serial_ids").default([]),
    issueDescription: text("issue_description").notNull(),
    status: varchar("status", { length: 30 }).notNull().default("submitted"),
    // Replacement record
    replacementQuantity: integer("replacement_quantity").notNull().default(0),
    replacementSerialNumbers: text("replacement_serial_numbers"),
    replacementReceivedDate: timestamp("replacement_received_date", {
      withTimezone: true,
    }),
    replacementBatchId: integer("replacement_batch_id"),
    // Recovery record — the supplier's reimbursement to the shop
    recoveryAmount: numeric("recovery_amount", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    recoveryMethod: varchar("recovery_method", { length: 20 })
      .notNull()
      .default("none"),
    recoveryReferenceId: integer("recovery_reference_id"),
    /** The shop's own direct cost (freight to supplier, repair labor...). */
    costAmount: numeric("cost_amount", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    submittedDate: timestamp("submitted_date", { withTimezone: true })
      .defaultNow()
      .notNull(),
    respondedDate: timestamp("responded_date", { withTimezone: true }),
    resolvedDate: timestamp("resolved_date", { withTimezone: true }),
    closedDate: timestamp("closed_date", { withTimezone: true }),
    notes: text("notes"),
    createdByUserId: integer("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "supplier_warranty_claims_status_check",
      sql`${table.status} IN ('submitted','sent_to_supplier','under_repair','replaced','rejected','closed','cancelled')`,
    ),
    check(
      "supplier_warranty_claims_recovery_check",
      sql`${table.recoveryMethod} IN ('none','credit_note','replacement','cash')`,
    ),
    check(
      "supplier_warranty_claims_amount_check",
      sql`${table.recoveryAmount} >= (0)::numeric AND ${table.costAmount} >= (0)::numeric`,
    ),
    unique("supplier_warranty_claims_id_business_uq").on(
      table.id,
      table.businessId,
    ),
    uniqueIndex("supplier_warranty_claims_number_business_uq").on(
      table.businessId,
      table.claimNumber,
    ),
    index("supplier_warranty_claims_business_status_idx").on(
      table.businessId,
      table.status,
    ),
    index("supplier_warranty_claims_supplier_idx").on(
      table.businessId,
      table.supplierId,
    ),
    index("supplier_warranty_claims_warranty_idx").on(
      table.businessId,
      table.supplierWarrantyId,
    ),
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "supplier_warranty_claims_location_business_fkey",
    }),
    foreignKey({
      columns: [table.supplierWarrantyId, table.businessId],
      foreignColumns: [supplierWarranties.id, supplierWarranties.businessId],
      name: "supplier_warranty_claims_warranty_business_fkey",
    }),
    foreignKey({
      columns: [table.supplierId, table.businessId],
      foreignColumns: [suppliers.id, suppliers.businessId],
      name: "supplier_warranty_claims_supplier_business_fkey",
    }),
    foreignKey({
      columns: [table.purchaseId, table.businessId],
      foreignColumns: [purchases.id, purchases.businessId],
      name: "supplier_warranty_claims_purchase_business_fkey",
    }),
    foreignKey({
      columns: [table.productId, table.businessId],
      foreignColumns: [products.id, products.businessId],
      name: "supplier_warranty_claims_product_business_fkey",
    }),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "supplier_warranty_claims_variant_business_fkey",
    }),
    foreignKey({
      columns: [table.customerWarrantyClaimId, table.businessId],
      foreignColumns: [warrantyClaims.id, warrantyClaims.businessId],
      name: "supplier_warranty_claims_customer_claim_business_fkey",
    }),
    foreignKey({
      columns: [table.replacementBatchId, table.businessId],
      foreignColumns: [inventoryBatches.id, inventoryBatches.businessId],
      name: "supplier_warranty_claims_replacement_batch_business_fkey",
    }),
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
      name: "supplier_warranty_claims_created_user_fkey",
    }),
  ],
);

/** Append-only supplier claim history (sale_order_events clone pattern). */
export const supplierWarrantyClaimEvents = pgTable(
  "supplier_warranty_claim_events",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    claimId: integer("claim_id").notNull(),
    supplierWarrantyId: integer("supplier_warranty_id").notNull(),
    eventType: varchar("event_type", { length: 40 }).notNull(),
    previousStatus: varchar("previous_status", { length: 30 }),
    newStatus: varchar("new_status", { length: 30 }),
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
      foreignColumns: [supplierWarrantyClaims.id, supplierWarrantyClaims.businessId],
      name: "supplier_warranty_claim_events_claim_business_fkey",
    }),
    index("supplier_warranty_claim_events_claim_created_idx").on(
      table.claimId,
      table.createdAt,
    ),
    index("supplier_warranty_claim_events_business_idx").on(table.businessId),
  ],
);
