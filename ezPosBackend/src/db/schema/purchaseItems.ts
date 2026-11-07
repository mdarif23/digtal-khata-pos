import {
  foreignKey,
  index,
  pgTable,
  serial,
  integer,
  unique,
  numeric,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { purchases } from "./purchases.js";
import { productVariants } from "./productVariants.js";
import { businesses } from "./businesses.js";

export const purchaseItems = pgTable(
  "purchase_items",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    purchaseId: integer("purchase_id").notNull(),
    variantId: integer("variant_id").notNull(),
    quantity: numeric("quantity", {
      precision: 12,
      scale: 3,
      mode: "number",
    }).notNull(),
    receivedQuantity: numeric("received_quantity", {
      precision: 12,
      scale: 3,
      mode: "number",
    }).notNull(),
    /**
     * Quantity-discrepancy split (migration 0052): `quantity` stays the
     * ordered amount and is NEVER mutated; `receivedQuantity` stays the
     * cumulative ACCEPTED quantity (all financial/landed/return math keys
     * off it); delivered = accepted + rejected (informational); cancelled
     * is set by short-receiving resolutions and is excluded from
     * outstanding (quantity − received − cancelled).
     *
     * Historical note: cancelled_quantity existed in the baseline migration
     * with trailing spaces in the identifier; 0052 renamed it clean.
     */
    deliveredQuantity: numeric("delivered_quantity", {
      precision: 12,
      scale: 3,
      mode: "number",
    })
      .notNull()
      .default(0),
    rejectedQuantity: numeric("rejected_quantity", {
      precision: 12,
      scale: 3,
      mode: "number",
    })
      .notNull()
      .default(0),
    cancelledQuantity: numeric("cancelled_quantity", {
      precision: 12,
      scale: 3,
      mode: "number",
    })
      .notNull()
      .default(0),
    unitCost: numeric("unit_cost", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    discount: numeric("discount", { precision: 12, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    tax: numeric("tax", { precision: 12, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    total: numeric("total", { precision: 12, scale: 2, mode: "number" })
      .notNull()
      .generatedAlwaysAs(sql`( (quantity * unit_cost) - discount + tax )`),
  },
  (table) => [
    index("purchase_items_business_id_idx").on(table.businessId),
    unique("purchase_items_id_business_uq").on(table.id, table.businessId),
    foreignKey({
      columns: [table.purchaseId, table.businessId],
      foreignColumns: [purchases.id, purchases.businessId],
      name: "purchase_items_purchase_business_fkey",
    }),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "purchase_items_variant_business_fkey",
    }),
  ],
);
