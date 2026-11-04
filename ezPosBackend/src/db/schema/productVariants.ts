import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  numeric,
  unique,
  varchar,
  boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { products } from "./products.js";
import { businesses } from "./businesses.js";

export const productVariants = pgTable(
  "product_variants",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    productId: integer("product_id").notNull(),
    sku: varchar({ length: 100 }).notNull(),
    barcode: varchar({ length: 100 }),
    /**
     * Symbology of the primary barcode (migration 0044): ean13 | ean8 |
     * upca | code128 | code39 | qr. NULL = unclassified/legacy — rendering
     * then auto-detects. Alias symbologies live on the alias rows.
     */
    barcodeFormat: varchar("barcode_format", { length: 20 }),
    sellingPrice: numeric("selling_price", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),

    /**
     * Automated replenishment (Module 2C): reorder when available stock
     * (current + outstanding purchases) falls to or below reorderPoint;
     * reorderQuantity is the default order size. NULL = no suggestion.
     */
    reorderPoint: integer("reorder_point"),
    reorderQuantity: integer("reorder_quantity"),
    alertQuantity: integer("alert_quantity").default(0),
    isDefault: boolean("is_default").default(false),
    status: varchar({ length: 30 }),

    /**
     * Variant unit weight for landed-cost weight allocation (Landed Cost
     * Management). NULL = not set; allocation then falls back to the
     * product-level `products.shipping_weight_kg` (kg) and errors only when
     * neither exists. Normalized to kg before allocation math.
     */
    weight: numeric("weight", { precision: 12, scale: 4, mode: "number" }),
    // No default on purpose (drizzle INSERTs defaulted columns; see
    // inventory_batches.additional_cost_per_unit). Services default to kg.
    weightUnit: varchar("weight_unit", { length: 5 }),
  },
  (table) => [
    index("product_variants_business_id_idx").on(table.businessId),
    // Candidate key for composite FKs from sale_items / purchase_items /
    // inventory_batches / inventory_movements / inventory_stock /
    // serial_numbers / variant_images / variant_values.
    unique("product_variants_id_business_uq").on(table.id, table.businessId),
    // Per-business SKU/barcode — two businesses may both use SKU-000001.
    unique("product_variants_business_sku_unique").on(table.businessId, table.sku),
    unique("product_variants_business_barcode_unique").on(
      table.businessId,
      table.barcode,
    ),
    check(
      "product_variants_weight_unit_check",
      sql`${table.weightUnit} IS NULL OR ${table.weightUnit} IN ('kg', 'g', 'lb', 'oz')`,
    ),
    foreignKey({
      columns: [table.productId, table.businessId],
      foreignColumns: [products.id, products.businessId],
      name: "product_variants_product_business_fkey",
    }),
  ],
);
