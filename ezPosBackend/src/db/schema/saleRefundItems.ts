import {
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  numeric,
} from "drizzle-orm/pg-core";
import { saleRefunds } from "./saleRefunds.js";
import { saleItems } from "./saleItems.js";
import { products } from "./products.js";
import { businesses } from "./businesses.js";

export const saleRefundItems = pgTable(
  "sale_refund_items",
  {
    id: serial().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    refundId: integer("refund_id"),
    saleItemId: integer("sale_item_id"),
    productId: integer("product_id"),
    // 0078: double precision — fractional sold-by-weight returns must land
    // in the ledger exactly (an integer column rounded 0.75→1 silently).
    quantity: doublePrecision(),
    refundPrice: numeric("refund_price", { mode: "number" }),
    refundTotal: numeric("refund_total", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("sale_refund_items_business_id_idx").on(table.businessId),
    foreignKey({
      columns: [table.refundId, table.businessId],
      foreignColumns: [saleRefunds.id, saleRefunds.businessId],
      name: "sale_refund_items_refund_business_fkey",
    }),
    // Repairs: sale_item_id and product_id previously had no foreign keys;
    // both now enforce same-business references.
    foreignKey({
      columns: [table.saleItemId, table.businessId],
      foreignColumns: [saleItems.id, saleItems.businessId],
      name: "sale_refund_items_sale_item_business_fkey",
    }),
    foreignKey({
      columns: [table.productId, table.businessId],
      foreignColumns: [products.id, products.businessId],
      name: "sale_refund_items_product_business_fkey",
    }),
  ],
);
