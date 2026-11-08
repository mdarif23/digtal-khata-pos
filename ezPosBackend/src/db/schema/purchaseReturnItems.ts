import {
  foreignKey,
  index,
  pgTable,
  serial,
  integer,
  numeric,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { products } from "./products.js";
import { purchaseReturns } from "./purchaseReturns.js";
import { purchaseItems } from "./purchaseItems.js";
import { productUnitConversions } from "./productUnitConversions.js";
import { businesses } from "./businesses.js";

export const purchaseReturnItems = pgTable(
  "purchase_return_items",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    purchaseReturnId: integer("purchase_return_id").notNull(),
    purchaseItemId: integer("purchase_item_id").notNull(),
    productId: integer("product_id").notNull(),
    quantity: numeric({ precision: 10, scale: 2, mode: "number" }).notNull(),
    unitPrice: numeric("unit_price", {
      precision: 14,
      scale: 6,
      mode: "number",
    }).notNull(),
    lineTotal: numeric("line_total", {
      precision: 12,
      scale: 2,
    }).generatedAlwaysAs(sql`(quantity * unit_price)`),
    /**
     * UOM snapshot (migration 0062): the unit the operator returned in
     * (original purchase unit or an authorized equivalent). Stored
     * quantity/unitPrice stay BASE-unit.
     */
    uomConversionId: integer("uom_conversion_id"),
    enteredQuantity: numeric("entered_quantity", {
      precision: 12,
      scale: 3,
      mode: "number",
    }),
    enteredUnitPrice: numeric("entered_unit_price", {
      precision: 14,
      scale: 6,
      mode: "number",
    }),
    conversionFactor: numeric("conversion_factor", {
      precision: 14,
      scale: 6,
      mode: "number",
    }),
  },
  (table) => [
    index("purchase_return_items_business_id_idx").on(table.businessId),
    foreignKey({
      columns: [table.purchaseReturnId, table.businessId],
      foreignColumns: [purchaseReturns.id, purchaseReturns.businessId],
      name: "purchase_return_items_return_business_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.purchaseItemId, table.businessId],
      foreignColumns: [purchaseItems.id, purchaseItems.businessId],
      name: "purchase_return_items_item_business_fkey",
    }),
    foreignKey({
      columns: [table.productId, table.businessId],
      foreignColumns: [products.id, products.businessId],
      name: "purchase_return_items_product_business_fkey",
    }),
    foreignKey({
      columns: [table.uomConversionId, table.businessId],
      foreignColumns: [productUnitConversions.id, productUnitConversions.businessId],
      name: "pri_uom_business_fkey",
    }),
    check("purchase_return_items_quantity_check", sql`quantity > (0)::numeric`),
  ],
);
