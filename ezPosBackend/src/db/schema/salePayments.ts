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
  unique,
  varchar,
  text,
} from "drizzle-orm/pg-core";
import { sales } from "./sales.js";
import { customers } from "./customers.js";
import { businesses } from "./businesses.js";

export const salePayments = pgTable(
  "sale_payments",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    saleId: integer("sale_id").notNull(),
    customerId: integer("customer_id").references(() => customers.id),
    amount: numeric("amount", { precision: 10, scale: 2, mode: "number" }).notNull(),
    paymentMethod: varchar("payment_method", { length: 50 }).notNull(), // cash | bangla_qr | card
    reference: varchar("reference", { length: 100 }),                   // digital transaction id
    tendered: numeric("tendered", { precision: 10, scale: 2, mode: "number" }), // cash only
    paymentDate: timestamp("payment_date", { mode: "string" }).defaultNow().notNull(),
    notes: text(),
  },
  (t) => [
    index("sale_payments_business_id_idx").on(t.businessId),
    check("sale_payments_amount_positive", sql`${t.amount} > 0`),
    check("sale_payments_method_valid", sql`${t.paymentMethod} in ('cash','bangla_qr','card')`),
    foreignKey({
      columns: [t.saleId, t.businessId],
      foreignColumns: [sales.id, sales.businessId],
      name: "sale_payments_sale_business_fkey",
    }),
    // References are scoped per business: two tenants recording the same
    // gateway reference (their own bKash/Nagad merchant accounts) is
    // legitimate and must not collide. Duplicates WITHIN a business for the
    // same method are still rejected — the cashier double-entry protection
    // is unchanged. (Resolves the previously pending policy decision; see
    // the Phase 1 roadmap in POS_GAP_CLOSURE_TRACKER.md.)
    unique("sale_payments_business_method_reference_unique").on(
      t.businessId,
      t.paymentMethod,
      t.reference,
    ),
  ],
);
