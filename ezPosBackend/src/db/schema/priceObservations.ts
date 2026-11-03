import {
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businesses } from "./businesses.js";
import { productVariants } from "./productVariants.js";
import { suppliers } from "./suppliers.js";
import { users } from "./users.js";

/**
 * Market price observations ("Quick Price Check"): manually recorded
 * supplier quotations gathered on wholesale market visits.
 *
 * These are deliberately a separate table from purchases — a quotation is
 * never a completed purchase. Actual purchase prices live only in
 * purchase_items / purchases; both sources are clearly labeled wherever
 * they are displayed together.
 */
export const priceObservations = pgTable(
  "price_observations",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id").notNull(),
    variantId: integer("variant_id").notNull(),
    supplierId: integer("supplier_id").notNull(),
    quotedPrice: numeric("quoted_price", { precision: 12, scale: 2, mode: "number" }).notNull(),
    // Package size the quotation refers to (e.g. 25 for a 25 KG sack).
    // Null means the quoted price is already per unit.
    packageQuantity: numeric("package_quantity", { precision: 12, scale: 3, mode: "number" }),
    observationDate: date("observation_date").notNull(),
    notes: text(),
    createdByUserId: integer("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("price_observations_business_variant_date_idx").on(
      table.businessId,
      table.variantId,
      table.observationDate,
    ),
    index("price_observations_business_supplier_idx").on(
      table.businessId,
      table.supplierId,
    ),
    check("price_observations_quoted_price_check", sql`${table.quotedPrice} >= 0`),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "price_observations_variant_business_fkey",
    }),
    foreignKey({
      columns: [table.supplierId, table.businessId],
      foreignColumns: [suppliers.id, suppliers.businessId],
      name: "price_observations_supplier_business_fkey",
    }),
    foreignKey({
      columns: [table.businessId],
      foreignColumns: [businesses.id],
      name: "price_observations_business_fkey",
    })
      .onDelete("cascade"),
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
      name: "price_observations_created_by_fkey",
    }),
  ],
);
