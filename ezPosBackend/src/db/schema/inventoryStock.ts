import {
  numeric,
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  unique,
} from "drizzle-orm/pg-core";
import { productVariants } from "./productVariants.js";
import { locations } from "./locations.js";
import { businesses } from "./businesses.js";

export const inventoryStock = pgTable(
  "inventory_stock",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    variantId: integer("variant_id")
      .references(() => productVariants.id)
      .notNull(),
    locationId: integer("location_id").references(() => locations.id),
    /** Phase 4: numeric(14,4) — weight variants hold fractional stock. */
    quantity: numeric("quantity", { precision: 14, scale: 4, mode: "number" })
      .default(0),
    reservedQuantity: numeric("reserved_quantity", {
      precision: 14,
      scale: 4,
      mode: "number",
    })
      .default(0),
  },
  (table) => [
    index("inventory_stock_business_id_idx").on(table.businessId),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "inventory_stock_variant_business_fkey",
    }),
    // One stock row per (business, variant, location). Legacy rows were
    // backfilled to the business's default location by migration 0003.
    unique("inventory_stock_business_variant_location_unique").on(
      table.businessId,
      table.variantId,
      table.locationId,
    ),
  ],
);
