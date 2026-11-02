import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  serial,
  integer,
  unique,
  text,
  numeric,
} from "drizzle-orm/pg-core";
import { sales } from "./sales.js";
import { productVariants } from "./productVariants.js";
import { businesses } from "./businesses.js";

export const saleItems = pgTable(
  "sale_items",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    saleId: integer("sale_id").notNull(),
    variantId: integer("variant_id").notNull(),
    quantity: integer("quantity").notNull(),
    sellingPrice: numeric("selling_price", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    discount: numeric("discount", { precision: 12, scale: 2, mode: "number" })
      .default(0)
      .notNull(),
    // productNameAtSale: text("product_name_at_sale").notNull(),
    costAtSale: numeric("cost_at_sale", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    lineTotal: numeric("line_total", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    /**
     * Historical tax snapshot (Module 4): the tax content of this line at
     * transaction time. Exclusive taxes are added on top of lineTotal;
     * inclusive taxes are extracted from it. taxDetail preserves the exact
     * rules applied (id, name, rate, mode, per-rule amount) so editing or
     * deactivating a tax rate can never rewrite financial history.
     */
    taxAmount: numeric("tax_amount", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    taxDetail: jsonb("tax_detail")
      .$type<
        {
          taxRateId: number;
          name: string;
          rate: number;
          isInclusive: boolean;
          amount: number;
        }[]
      >()
      .default([])
      .notNull(),
  },
  (table) => [
    index("sale_items_business_id_idx").on(table.businessId),
    unique("sale_items_id_business_uq").on(table.id, table.businessId),
    foreignKey({
      columns: [table.saleId, table.businessId],
      foreignColumns: [sales.id, sales.businessId],
      name: "sale_items_sale_business_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "sale_items_variant_business_fkey",
    }).onDelete("restrict"),
  ],
);
