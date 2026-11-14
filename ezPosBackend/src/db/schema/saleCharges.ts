import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sales } from "./sales.js";
import { businesses } from "./businesses.js";

/**
 * P3 Phase 1 (F1, migration 0080): named sale-level charges — delivery,
 * service, packing fees a cashier adds to a ticket. Post-VAT additive
 * components of sales.final_total (approved decision D1), never sale_items,
 * so product-level profitability (which aggregates sale_items) is unaffected
 * by construction. The storefront's sales.delivery_fee keeps its online-only
 * semantics — POS charges never write that column.
 */
export const saleCharges = pgTable(
  "sale_charges",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    saleId: integer("sale_id").notNull(),
    /** Human label printed on the receipt, e.g. "Delivery", "Service fee". */
    label: varchar("label", { length: 120 }).notNull(),
    /** Non-negative; the SUM is part of sales.final_total. */
    amount: numeric("amount", { precision: 10, scale: 2, mode: "number" }).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("sale_charges_business_sale_idx").on(t.businessId, t.saleId),
    check("sale_charges_amount_nonnegative", sql`${t.amount} >= 0`),
    check("sale_charges_label_nonempty", sql`length(btrim(${t.label})) > 0`),
    foreignKey({
      columns: [t.saleId, t.businessId],
      foreignColumns: [sales.id, sales.businessId],
      name: "sale_charges_sale_business_fkey",
    }),
  ],
);
