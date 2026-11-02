import { sql } from "drizzle-orm";
import {
  boolean,
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
 * Loyalty program (Module 7). One program per business; the points ledger
 * mirrors the store-credit ledger: positive rows earn, negative rows
 * redeem/reverse, balance = SUM(points). Consumers lock the customer's rows
 * FOR UPDATE so concurrent checkouts cannot overspend. Earn rate is points
 * per currency unit spent; redeem value is currency per point.
 */
export const loyaltyPrograms = pgTable(
  "loyalty_programs",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /** Points earned per 1 unit of currency paid (0.01 → 1pt per ৳100). */
    earnRate: numeric("earn_rate", { precision: 10, scale: 4, mode: "number" })
      .notNull()
      .default(0.01),
    /** Currency value of one point when redeeming (1 → 1pt = ৳1). */
    redeemValue: numeric(
      "redeem_value",
      { precision: 10, scale: 4, mode: "number" },
    )
      .notNull()
      .default(1),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "loyalty_programs_rates_positive",
      sql`${t.earnRate} >= 0 AND ${t.redeemValue} >= 0`,
    ),
  ],
);

export const loyaltyLedger = pgTable(
  "loyalty_ledger",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** Positive = earned; negative = redeemed or reversed. Never zero. */
    points: numeric("points", { precision: 12, scale: 2, mode: "number" })
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
    index("loyalty_ledger_business_customer_idx").on(t.businessId, t.customerId),
    check("loyalty_ledger_points_nonzero", sql`${t.points} <> 0`),
    check(
      "loyalty_ledger_source_valid",
      sql`${t.sourceType} in ('sale_earn','redeem','refund_reversal','manual')`,
    ),
  ],
);
