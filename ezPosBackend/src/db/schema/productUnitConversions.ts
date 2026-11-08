import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { products } from "./products.js";
import { productVariants } from "./productVariants.js";
import { units } from "./units.js";
import { businesses } from "./businesses.js";

/**
 * Multiple Units of Measure (UOM) & Packaging Conversion (migrations
 * 0061/0062). One row per (product, variant-scope, unit): a packaging unit
 * the business may purchase or sell the product in, with its direct-to-base
 * conversion factor (1 Box = 12 Pieces → factor 12).
 *
 * ZERO-TOUCH MIGRATION CONTRACT: the product's `products.unit_id` IS the
 * base unit — the base unit never gets a row here (implicit factor 1,
 * always purchasable/sellable), and a product with zero rows behaves
 * exactly like a single-unit product. All stored transaction quantities
 * and per-unit costs remain base-unit; the unit the user typed lives only
 * in the nullable snapshot columns on purchase_items / sale_items /
 * purchase_receiving_records / purchase_return_items.
 *
 * sale_price / purchase_price are per-THIS-unit default prices for
 * prefill/display only — actual transaction prices are always captured per
 * line, and the backend resolves authoritative factors/prices from these
 * rows (frontend-submitted factors are advisory).
 */
export const productUnitConversions = pgTable(
  "product_unit_conversions",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    productId: integer("product_id").notNull(),
    /** NULL = product-level default; set = variant-specific override. */
    variantId: integer("variant_id"),
    unitId: integer("unit_id").notNull(),
    /** How many base units one of this unit contains (> 0, direct-to-base). */
    conversionFactor: numeric("conversion_factor", {
      precision: 14,
      scale: 6,
      mode: "number",
    }).notNull(),
    isPurchaseEnabled: boolean("is_purchase_enabled").default(true).notNull(),
    isSaleEnabled: boolean("is_sale_enabled").default(true).notNull(),
    isDefaultPurchase: boolean("is_default_purchase").default(false).notNull(),
    isDefaultSale: boolean("is_default_sale").default(false).notNull(),
    salePrice: numeric("sale_price", { precision: 14, scale: 2, mode: "number" }),
    purchasePrice: numeric("purchase_price", {
      precision: 14,
      scale: 2,
      mode: "number",
    }),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "puc_factor_positive_check",
      sql`${table.conversionFactor} > (0)::numeric`,
    ),
    check(
      "puc_status_check",
      sql`${table.status} IN ('active', 'inactive')`,
    ),
    unique("puc_id_business_uq").on(table.id, table.businessId),
    uniqueIndex("puc_product_unit_uq").on(
      table.productId,
      sql`COALESCE(${table.variantId}, 0)`,
      table.unitId,
    ),
    // At most one default purchase/sale unit per scope; partial so inactive
    // rows never block a new default.
    uniqueIndex("puc_default_sale_uq")
      .on(table.productId, sql`COALESCE(${table.variantId}, 0)`)
      .where(sql`${table.isDefaultSale} AND ${table.status} = 'active'`),
    uniqueIndex("puc_default_purchase_uq")
      .on(table.productId, sql`COALESCE(${table.variantId}, 0)`)
      .where(sql`${table.isDefaultPurchase} AND ${table.status} = 'active'`),
    index("puc_business_idx").on(table.businessId),
    index("puc_product_idx").on(table.productId),
    index("puc_variant_idx").on(table.variantId),
    foreignKey({
      columns: [table.productId, table.businessId],
      foreignColumns: [products.id, products.businessId],
      name: "puc_product_business_fkey",
    }),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "puc_variant_business_fkey",
    }),
    foreignKey({
      columns: [table.unitId, table.businessId],
      foreignColumns: [units.id, units.businessId],
      name: "puc_unit_business_fkey",
    }),
  ],
);

/**
 * Shared snapshot column shape for transaction lines that accept an entered
 * packaging unit. Stored quantity/cost columns stay base-unit; these columns
 * preserve what the operator typed and the factor AT TRANSACTION TIME so
 * historical records never depend on current packaging settings.
 */
export interface UomLineSnapshot {
  uomConversionId: number | null;
  enteredQuantity: number | null;
  enteredUnitPrice: number | null;
  conversionFactor: number | null;
}
