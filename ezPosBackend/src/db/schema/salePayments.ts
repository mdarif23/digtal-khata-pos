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
    // sslcommerz: storefront/online order gateway capture (stage 5).
    check(
      "sale_payments_method_valid",
      sql`${t.paymentMethod} in ('cash','bangla_qr','card','sslcommerz')`,
    ),
    foreignKey({
      columns: [t.saleId, t.businessId],
      foreignColumns: [sales.id, sales.businessId],
      name: "sale_payments_sale_business_fkey",
    }),
    // Per-business reference uniqueness (policy resolved stage 5): a gateway
    // reference recorded by one business must never block another's. Global
    // uniqueness was a cross-tenant coupling hazard.
    unique("sale_payments_method_reference_unique").on(
      t.businessId,
      t.paymentMethod,
      t.reference,
    ),
  ],
);
