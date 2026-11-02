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
import { sql } from "drizzle-orm";
import { businesses } from "./businesses.js";
import { sales } from "./sales.js";
import { storefronts } from "./storefronts.js";

/**
 * Gateway payment sessions for online orders (stage 5). One row per ORDER
 * (idempotency_key = `ord-<saleId>`): retries reset the same row so the
 * gateway always sees one stable tran_id.
 *
 * THE rule (same as subscriptions): an order is never marked paid because a
 * browser landed on a success page — payment succeeds only inside the
 * verify core after SERVER-side gateway validation and an amount match.
 * On success the ledger entry lands in sale_payments and the order is
 * confirmed (stock consumed) in the same transaction.
 */
export const onlineOrderPayments = pgTable(
  "online_order_payments",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    storefrontId: integer("storefront_id").references(() => storefronts.id, {
      onDelete: "set null",
    }),
    saleId: integer("sale_id").notNull(),
    /** Gateway transaction id = idempotency key (`ord-<saleId>`). */
    idempotencyKey: varchar("idempotency_key", { length: 120 })
      .notNull()
      .unique(),
    provider: varchar({ length: 30 }).notNull(),
    amount: numeric("amount", { precision: 10, scale: 2, mode: "number" }).notNull(),
    currency: varchar({ length: 3 }).default("BDT").notNull(),
    /** pending | succeeded | failed | cancelled */
    status: varchar({ length: 20 }).default("pending").notNull(),
    sessionId: varchar("session_id", { length: 255 }),
    /** Gateway validation id captured at verification. */
    valId: varchar("val_id", { length: 255 }),
    /** Bank/gateway transaction reference captured at verification. */
    gatewayReference: varchar("gateway_reference", { length: 255 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("online_order_payments_business_idx").on(t.businessId),
    index("online_order_payments_sale_idx").on(t.saleId),
    check("online_order_payments_amount_positive", sql`${t.amount} > 0`),
    check(
      "online_order_payments_status_valid",
      sql`${t.status} in ('pending','succeeded','failed','cancelled')`,
    ),
    foreignKey({
      columns: [t.saleId, t.businessId],
      foreignColumns: [sales.id, sales.businessId],
      name: "online_order_payments_sale_business_fkey",
    }),
  ],
);
