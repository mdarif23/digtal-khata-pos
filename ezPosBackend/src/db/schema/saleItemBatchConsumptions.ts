import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businesses } from "./businesses.js";
import { inventoryBatches } from "./inventoryBatches.js";
import { productVariants } from "./productVariants.js";
import { saleItems } from "./saleItems.js";
import { sales } from "./sales.js";

/**
 * Persisted per-batch sale consumption (audit decision Q2).
 *
 * `consumeStockFifo` has always computed `sale_items.cost_at_sale` as a
 * blended per-line average and thrown the per-batch detail away, which makes
 * any later landed-cost adjustment unable to tell which sold units came from
 * which batch. Writing one row per (sale item × batch) here preserves that
 * detail with zero behavior change: FIFO ordering, locking and the
 * cost_at_sale snapshot are untouched, this table only records what was
 * already computed. Landed-cost adjustments read it to split an adjustment
 * exactly between remaining batches (inventory) and sold units (COGS).
 *
 * unitCostAtConsumption is the batch's effective unit cost at the moment of
 * consumption (purchase_price + additional_cost_per_unit as of then) — the
 * number that actually entered cost_at_sale.
 */
export const saleItemBatchConsumptions = pgTable(
  "sale_item_batch_consumptions",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    saleId: integer("sale_id").notNull(),
    saleItemId: integer("sale_item_id").notNull(),
    batchId: integer("batch_id").notNull(),
    variantId: integer("variant_id").notNull(),

    quantity: integer("quantity").notNull(),
    unitCostAtConsumption: numeric("unit_cost_at_consumption", {
      precision: 14,
      scale: 6,
      mode: "number",
    }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("sale_item_batch_consumptions_item_idx").on(table.saleItemId),
    index("sale_item_batch_consumptions_batch_idx").on(table.batchId),
    unique("sale_item_batch_consumptions_id_business_uq").on(
      table.id,
      table.businessId,
    ),
    check("sale_item_batch_consumptions_qty_check", sql`${table.quantity} > 0`),
    foreignKey({
      columns: [table.saleId, table.businessId],
      foreignColumns: [sales.id, sales.businessId],
      name: "sale_item_batch_consumptions_sale_business_fkey",
    }),
    foreignKey({
      columns: [table.saleItemId, table.businessId],
      foreignColumns: [saleItems.id, saleItems.businessId],
      name: "sale_item_batch_consumptions_sale_item_business_fkey",
    }),
    foreignKey({
      columns: [table.batchId, table.businessId],
      foreignColumns: [inventoryBatches.id, inventoryBatches.businessId],
      name: "sale_item_batch_consumptions_batch_business_fkey",
    }),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "sale_item_batch_consumptions_variant_business_fkey",
    }),
  ],
);
