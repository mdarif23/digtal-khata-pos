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
 * Gift cards (Module 7). Codes are stored ONLY as SHA-256 hashes — the full
 * code is shown once at issuance and never recoverable. The balance is a
 * pure transaction ledger (+ issue, − redeem): balance = SUM(amount),
 * reconciling by construction. Redemption locks the card's ledger FOR
 * UPDATE inside the sale transaction, so concurrent double-redemption is
 * impossible; expired or deactivated cards cannot redeem.
 */
export const giftCards = pgTable(
  "gift_cards",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /** SHA-256 of the full code — the code itself is never stored. */
    codeHash: varchar("code_hash", { length: 64 }).notNull().unique(),
    codeLast4: varchar("code_last4", { length: 4 }).notNull(),
    initialAmount: numeric(
      "initial_amount",
      { precision: 10, scale: 2, mode: "number" },
    ).notNull(),
    status: varchar({ length: 20 }).notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    customerId: integer("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    issuedByUserId: integer("issued_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    note: text(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("gift_cards_business_idx").on(t.businessId),
    check("gift_cards_amount_positive", sql`${t.initialAmount} > 0`),
    check("gift_cards_status_valid", sql`${t.status} in ('active','inactive')`),
  ],
);

export const giftCardTransactions = pgTable(
  "gift_card_transactions",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    giftCardId: integer("gift_card_id")
      .notNull()
      .references(() => giftCards.id, { onDelete: "cascade" }),
    /** Positive = issued; negative = redeemed. Never zero. */
    amount: numeric("amount", { precision: 10, scale: 2, mode: "number" })
      .notNull(),
    sourceType: varchar("source_type", { length: 20 }).notNull(),
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
    index("gift_card_transactions_card_idx").on(t.giftCardId),
    check("gift_card_transactions_amount_nonzero", sql`${t.amount} <> 0`),
    check(
      "gift_card_transactions_source_valid",
      sql`${t.sourceType} in ('issue','redeem')`,
    ),
  ],
);
