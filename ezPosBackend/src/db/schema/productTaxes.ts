import {
  integer,
  pgTable,
  primaryKey,
  timestamp,
} from "drizzle-orm/pg-core";
import { products } from "./products.js";
import { taxRates } from "./taxRates.js";

/**
 * Product-level tax assignment (many-to-many). A product with no rows here
 * is tax-exempt under the rules engine. Sales snapshot the resolved rules
 * at transaction time — editing this table never rewrites history.
 */
export const productTaxes = pgTable(
  "product_taxes",
  {
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    taxRateId: integer("tax_rate_id")
      .notNull()
      .references(() => taxRates.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.taxRateId] }),
  ],
);
