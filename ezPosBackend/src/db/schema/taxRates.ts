import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";

/**
 * Configurable tax rates (Module 4 tax engine).
 *
 * A rate is a percentage with a pricing mode: exclusive (added on top of
 * the price, e.g. classic VAT) or inclusive (already inside the price,
 * extracted for reporting). Historical sales never reference the live row
 * for money math — createSale snapshots name/rate/mode per line into
 * sale_items.tax_detail, so editing or deactivating a rate can never
 * rewrite history. `locationId` NULL means the rate applies business-wide;
 * effective dates bound when the rate applies (matched against saleDate).
 *
 * Rates are deactivated (is_active=false), never hard-deleted: product
 * assignments and past snapshots may reference them.
 */
export const taxRates = pgTable(
  "tax_rates",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: varchar({ length: 80 }).notNull(), // e.g. "VAT 15%"
    /** Percent, up to 3 decimals (15.000). */
    rate: numeric("rate", { precision: 6, scale: 3, mode: "number" }).notNull(),
    isInclusive: boolean("is_inclusive").notNull().default(false),
    locationId: integer("location_id").references(() => locations.id, {
      onDelete: "set null",
    }),
    validFrom: date("valid_from", { mode: "string" }),
    validTo: date("valid_to", { mode: "string" }),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("tax_rates_business_idx").on(t.businessId),
    check("tax_rates_rate_range", sql`${t.rate} >= 0 AND ${t.rate} <= 100`),
  ],
);
