import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { customers } from "./customers.js";
import { users } from "./users.js";

/**
 * Store credit / customer account ledger (Module 5). A pure transaction
 * ledger: positive rows GRANT credit (refund settlements, manual top-ups),
 * negative rows CONSUME it (sale payments). The balance is SUM(amount) —
 * balances reconcile with the ledger by construction, per the master
 * prompt's financial invariants.
 *
 * Concurrency: consumers lock the customer's rows FOR UPDATE inside the
 * sale transaction before computing the balance, so two concurrent
 * checkouts cannot overspend the same credit.
 */
export const customerCredits = pgTable(
  "customer_credits",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** Positive = credit granted; negative = consumed. Never zero. */
    amount: numeric("amount", { precision: 10, scale: 2, mode: "number" })
      .notNull(),
    sourceType: varchar("source_type", { length: 20 }).notNull(),
    /** Refund id, sale id, or null for manual entries. */
    sourceId: integer("source_id"),
    actorUserId: integer("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    note: text(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("customer_credits_business_customer_idx").on(
      t.businessId,
      t.customerId,
    ),
    check("customer_credits_amount_nonzero", sql`${t.amount} <> 0`),
    check(
      "customer_credits_source_valid",
      sql`${t.sourceType} in ('refund','sale_payment','manual')`,
    ),
  ],
);
