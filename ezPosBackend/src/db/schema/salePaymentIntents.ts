import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { sales } from "./sales.js";

/**
 * Electronic sale-payment intents (Phase 1 payment architecture).
 *
 * A POS cashier (or the due-collection portal) creates an intent against a
 * completed sale with outstanding due; the customer completes it on the
 * provider's own surface (gateway page / QR / USSD); the result is ALWAYS
 * verified server-side (never from a redirect alone) before a
 * `sale_payments` row is recorded and the sale's due is reduced.
 *
 * Status machine:
 *   pending → captured   (verified; payment row recorded, sale updated)
 *   pending → failed     (provider rejected or verification failed)
 *   pending → cancelled  (cashier or timeout)
 * The idempotency key doubles as the gateway tran_id, so provider retries
 * and IPN callbacks land on the same row.
 */
export const salePaymentIntents = pgTable(
  "sale_payment_intents",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    saleId: integer("sale_id").notNull(),
    provider: varchar({ length: 40 }).notNull(),
    /** Method recorded on the captured sale_payments row — same CHECK set. */
    method: varchar("method", { length: 50 }).notNull(),
    amount: numeric("amount", { precision: 10, scale: 2, mode: "number" })
      .notNull(),
    currency: varchar({ length: 3 }).notNull().default("BDT"),
    status: varchar({ length: 20 }).notNull().default("pending"),
    providerSessionId: varchar("provider_session_id", { length: 120 }),
    providerTxnId: varchar("provider_txn_id", { length: 120 }),
    gatewayUrl: text("gateway_url"),
    /** Client-generated; also sent to the gateway as tran_id. */
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    verifyAttempts: integer("verify_attempts").notNull().default(0),
    lastError: text("last_error"),
    rawResponse: jsonb("raw_response").$type<Record<string, unknown>>(),
    capturedSalePaymentId: integer("captured_sale_payment_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("sale_payment_intents_business_idempotency_unique").on(
      t.businessId,
      t.idempotencyKey,
    ),
    foreignKey({
      columns: [t.saleId, t.businessId],
      foreignColumns: [sales.id, sales.businessId],
      name: "sale_payment_intents_sale_business_fkey",
    }),
    check(
      "sale_payment_intents_amount_positive",
      sql`${t.amount} > 0`,
    ),
    check(
      "sale_payment_intents_status_valid",
      sql`${t.status} in ('pending','captured','failed','cancelled')`,
    ),
    check(
      "sale_payment_intents_method_valid",
      sql`${t.method} in ('bangla_qr','card')`,
    ),
    index("sale_payment_intents_business_idx").on(t.businessId, t.createdAt),
    index("sale_payment_intents_sale_idx").on(t.saleId),
  ],
);
