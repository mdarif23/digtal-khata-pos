import {
  pgTable,
  serial,
  index,
  integer,
  unique,
  varchar,
  doublePrecision,
  boolean,
  numeric,
  text,
  timestamp,
  pgSequence,
} from "drizzle-orm/pg-core";
import { categories } from "./categories.js";
import { brands } from "./brands.js";
import { units } from "./units.js";
import { businesses } from "./businesses.js";
// Sequence
export const productSkuSeq = pgSequence("product_sku_seq", {
  startWith: 1,
  increment: 1,
});
export const products = pgTable(
  "products",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    name: varchar({ length: 100 }).notNull(),
    categoryId: integer("category_id").references(() => categories.id),
    brandId: integer("brand_id").references(() => brands.id),
    unitId: integer("unit_id").references(() => units.id),
    description: varchar({ length: 200 }),
    productType: varchar("product_type", { length: 20 }),
    hasVariants: boolean("has_variants").default(false),
    trackingType: varchar("tracking_type", { length: 20 }),
    status: varchar({ length: 30 }),
    /**
     * Shipping & packaging defaults for online orders. COPIED into
     * sale_packages at pack time — editing these never rewrites an
     * already-processed order.
     */
    shippingWeightKg: numeric("shipping_weight_kg", {
      precision: 10,
      scale: 3,
      mode: "number",
    }),
    shippingLengthCm: numeric("shipping_length_cm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    shippingWidthCm: numeric("shipping_width_cm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    shippingHeightCm: numeric("shipping_height_cm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    packagingInstructions: text("packaging_instructions"),
    handlingInstructions: text("handling_instructions"),
    isFragile: boolean("is_fragile").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    /**
     * Offline selling policy (Phase 3). 'allocated' (default): the terminal
     * may sell up to its server-granted allowance. 'blocked': never sell
     * offline (serial-tracked products are always blocked in code — the
     * same serial must never sell twice). 'open': sell freely offline;
     * overages auto-apply and land in sync_conflicts for manager review.
     */
    offlinePolicy: varchar("offline_policy", { length: 20 })
      .default("allocated")
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("products_business_id_idx").on(table.businessId),
    // Candidate key for composite foreign keys from product_variants.
    unique("products_id_business_uq").on(table.id, table.businessId),
  ],
);
