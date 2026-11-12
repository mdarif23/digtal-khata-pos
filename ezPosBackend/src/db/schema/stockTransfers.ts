import { sql } from "drizzle-orm";
import {
  jsonb,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";
import { productVariants } from "./productVariants.js";
import { users } from "./users.js";

export const stockTransferStatusEnum = pgEnum("stock_transfer_status", [
  "draft",
  "shipped",
  "partially_received",
  "received",
  "cancelled",
]);

/**
 * Inter-location stock transfer. Shipping deducts stock (and consumes FIFO
 * batches) at the source location; the destination stock is increased ONLY
 * when items are received. Shipped-but-unreceived quantities are the
 * in-transit balance (derived, never double-counted as stock).
 */
export const stockTransfers = pgTable(
  "stock_transfers",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    transferNumber: varchar("transfer_number", { length: 30 }).notNull(),
    fromLocationId: integer("from_location_id").notNull(),
    toLocationId: integer("to_location_id").notNull(),
    status: stockTransferStatusEnum("status").default("draft").notNull(),
    notes: text(),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    /** Phase 4 (Feature 17): explicit authorization; ship auto-authorizes. */
    authorizedBy: integer("authorized_by").references(() => users.id, {
      onDelete: "set null",
    }),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique("stock_transfers_business_number_unique").on(
      table.businessId,
      table.transferNumber,
    ),
    unique("stock_transfers_id_business_uq").on(table.id, table.businessId),
    index("stock_transfers_business_status_idx").on(
      table.businessId,
      table.status,
    ),
    foreignKey({
      columns: [table.fromLocationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "stock_transfers_from_location_business_fkey",
    }),
    foreignKey({
      columns: [table.toLocationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "stock_transfers_to_location_business_fkey",
    }),
    check(
      "stock_transfers_different_locations_check",
      sql`${table.fromLocationId} <> ${table.toLocationId}`,
    ),
  ],
);

export const stockTransferItems = pgTable(
  "stock_transfer_items",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    transferId: integer("transfer_id").notNull(),
    variantId: integer("variant_id").notNull(),
    quantity: integer("quantity").notNull(),
    quantityShipped: integer("quantity_shipped").default(0).notNull(),
    quantityReceived: integer("quantity_received").default(0).notNull(),
    /** Weighted cost per unit computed at ship time — the destination
     *  batch's cost basis (valuation continuity across locations). */
    unitCost: numeric("unit_cost", { precision: 10, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    /** Phase 4: serial numbers shipped for serial-tracked variants. */
    serialNumbers: jsonb("serial_numbers").$type<string[]>(),
  },
  (table) => [
    index("stock_transfer_items_transfer_idx").on(table.transferId),
    foreignKey({
      columns: [table.transferId, table.businessId],
      foreignColumns: [stockTransfers.id, stockTransfers.businessId],
      name: "stock_transfer_items_transfer_business_fkey",
    }),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "stock_transfer_items_variant_business_fkey",
    }),
  ],
);

/**
 * Phase 4 (Feature 17): receive-time shortfalls recorded explicitly — the
 * shipped quantity that never arrived, with the receiver's reason. Tenancy
 * enforced via the composite FK to stock_transfers.
 */
export const transferDiscrepancies = pgTable(
  "transfer_discrepancies",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    transferId: integer("transfer_id").notNull(),
    itemId: integer("item_id").notNull(),
    shippedQty: integer("shipped_qty").notNull(),
    receivedQty: integer("received_qty").notNull(),
    difference: integer("difference").notNull(),
    reason: text(),
    recordedBy: integer("recorded_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("transfer_discrepancies_transfer_idx").on(table.transferId),
    foreignKey({
      columns: [table.transferId, table.businessId],
      foreignColumns: [stockTransfers.id, stockTransfers.businessId],
      name: "transfer_discrepancies_transfer_business_fkey",
    }),
  ],
);
