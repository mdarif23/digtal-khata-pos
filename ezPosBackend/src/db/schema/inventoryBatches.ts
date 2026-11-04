import {
  foreignKey,
  index,
  pgTable,
  serial,
  integer,
  unique,
  varchar,
  numeric,
  date,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { purchaseItems } from "./purchaseItems.js";
import { productVariants } from "./productVariants.js";
import { locations } from "./locations.js";
import { businesses } from "./businesses.js";

export const inventoryBatches = pgTable(
  "inventory_batches",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    variantId: integer("variant_id"),
    locationId: integer("location_id"),
    purchaseItemId: integer("purchase_item_id"),
    batchNumber: varchar("batch_number", { length: 100 }).notNull(),

    // Original purchase cost — NEVER modified by the landed-cost module.
    purchasePrice: numeric("purchase_price", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).notNull(),

    /**
     * Landed Cost Management: allocated additional cost (freight, customs…)
     * per unit, on top of the untouched original purchase price. Zero for
     * every batch that received no landed-cost allocation, so all existing
     * valuation/COGS math is unchanged until a document posts. 6 decimal
     * places absorb per-unit allocation rounding; currency rounding happens
     * at posting boundaries.
     */
    // Nullable WITHOUT a database default on purpose: drizzle includes
    // defaulted columns in every INSERT, and until migration 0042 is applied
    // the column must not appear there. Readers use
    // landed_cost_per_unit (COALESCE-safe) or coalesce(additional, 0).
    additionalCostPerUnit: numeric("additional_cost_per_unit", {
      precision: 14,
      scale: 6,
      mode: "number",
    }),

    // Canonical effective unit cost (original + additional), generated so
    // every valuation/COGS reader uses one formula instead of re-deriving it.
    landedCostPerUnit: numeric("landed_cost_per_unit", {
      precision: 14,
      scale: 6,
      mode: "number",
    }).notNull().generatedAlwaysAs(
      sql`( (purchase_price + coalesce(additional_cost_per_unit, 0)) )`,
    ),

    quantityReceived: integer("quantity_received").notNull(),
    quantityRemaining: integer("quantity_remaining").notNull(),

    manufacturedDate: date("manufactured_date", { mode: "date" }),
    expiryDate: date("expiry_date", { mode: "date" }),
  },
  (table) => [
    index("inventory_batches_business_id_idx").on(table.businessId),
    // FIFO queries filter on (variant, location) and returns on
    // (purchase_item) — index them.
    index("inventory_batches_variant_location_idx").on(
      table.variantId,
      table.locationId,
    ),
    index("inventory_batches_purchase_item_idx").on(table.purchaseItemId),
    unique("inventory_batches_id_business_uq").on(table.id, table.businessId),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "inventory_batches_variant_business_fkey",
    }),
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "inventory_batches_location_business_fkey",
    }),
    foreignKey({
      columns: [table.purchaseItemId, table.businessId],
      foreignColumns: [purchaseItems.id, purchaseItems.businessId],
      name: "inventory_batches_purchase_item_business_fkey",
    }),
  ],
);
