import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import { customers } from "./customers.js";
import { users } from "./users.js";

/**
 * Loyalty engine (Phase 2A — master prompt Feature 5). One program per
 * business; the ± ledger stays the single source of truth (balance =
 * SUM(points)) and consumers lock the customer's rows FOR UPDATE.
 *
 * Phase 2 additions:
 *  - expiry via redeemable point batches (loyalty_points_batches);
 *  - earning rules (exclusions, minimum spend, campaign multiplier/bonus);
 *  - tiers derived from qualifying spend (customer_loyalty_state);
 *  - redemption caps (min points, max per sale);
 *  - ledger enrichment (entry_type, balance_after, expires_at).
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
    /** 'none' = points never expire; 'fixed' = expiry_days after earning. */
    expiryMode: varchar("expiry_mode", { length: 10 }).notNull().default("none"),
    /** Fixed-expiry length in days; required when expiry_mode = 'fixed'. */
    expiryDays: integer("expiry_days"),
    /** Minimum points a redemption must spend; 0 = no minimum. */
    minRedemptionPoints: numeric("min_redemption_points", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    /** Ceiling on points one sale may redeem; NULL = uncapped. */
    maxRedemptionPointsPerSale: numeric("max_redemption_points_per_sale", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
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
    check(
      "loyalty_programs_expiry_mode_check",
      sql`${t.expiryMode} IN ('none', 'fixed')`,
    ),
  ],
);

/**
 * Earning rules (Phase 2A): one configurable rule set per business —
 * exclusions, minimum spend, campaign window, multiplier and flat bonus.
 * Composed by the engine: points = eligibleBase × earnRate ×
 * rule.multiplier × tier.multiplier (+ bonus).
 */
export const loyaltyEarnRules = pgTable(
  "loyalty_earn_rules",
  {
    businessId: integer("business_id")
      .primaryKey()
      .references(() => businesses.id, { onDelete: "cascade" }),
    isActive: boolean("is_active").notNull().default(true),
    /** Sale's eligible base must reach this to earn at all. */
    minTransactionAmount: numeric("min_transaction_amount", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    /** Category/product ids whose lines never earn. */
    excludedCategoryIds: jsonb("excluded_category_ids")
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    excludedProductIds: jsonb("excluded_product_ids")
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Flat bonus points per qualifying sale. */
    bonusPoints: numeric("bonus_points", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    multiplier: numeric("multiplier", {
      precision: 6,
      scale: 3,
      mode: "number",
    })
      .notNull()
      .default(1),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "loyalty_earn_rules_multiplier_check",
      sql`${t.multiplier} >= 0`,
    ),
  ],
);

/** Tier benefits: bonus earning multiplier, spend threshold, window. */
export const loyaltyTiers = pgTable(
  "loyalty_tiers",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 60 }).notNull(),
    /** Qualifying spend needed to hold this tier. */
    minSpend: numeric("min_spend", {
      precision: 14,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    /** NULL = lifetime spend; N = spend within the trailing N months. */
    qualificationMonths: integer("qualification_months"),
    earnMultiplier: numeric("earn_multiplier", {
      precision: 6,
      scale: 3,
      mode: "number",
    })
      .notNull()
      .default(1),
    /** Higher rank wins when several thresholds are met. */
    rank: integer("rank").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("loyalty_tiers_business_name_uq").on(t.businessId, t.name),
    index("loyalty_tiers_business_rank_idx").on(t.businessId, t.rank),
    check(
      "loyalty_tiers_values_check",
      sql`${t.minSpend} >= 0 AND ${t.earnMultiplier} >= 0 AND (${t.qualificationMonths} IS NULL OR ${t.qualificationMonths} > 0)`,
    ),
  ],
);

/** Per-customer tier + lifetime counters, updated transactionally. */
export const customerLoyaltyState = pgTable(
  "customer_loyalty_state",
  {
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" })
      .primaryKey(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" })
      .primaryKey(),
    tierId: integer("tier_id").references(() => loyaltyTiers.id, {
      onDelete: "set null",
    }),
    lifetimeEarned: numeric("lifetime_earned", {
      precision: 14,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    lifetimeRedeemed: numeric("lifetime_redeemed", {
      precision: 14,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    lifetimeSpend: numeric("lifetime_spend", {
      precision: 14,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

/**
 * Redeemable point batches — the expiry model. Every earn creates a batch;
 * redemption consumes batches FIFO by soonest expiry; the sweep zeroes
 * expired batches and writes 'expiry' ledger rows.
 */
export const loyaltyPointsBatches = pgTable(
  "loyalty_points_batches",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    pointsOriginal: numeric("points_original", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    pointsRemaining: numeric("points_remaining", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    earnedAt: timestamp("earned_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** NULL = never expires. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    sourceType: varchar("source_type", { length: 20 }).notNull().default("sale_earn"),
    ledgerId: integer("ledger_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("loyalty_points_batches_customer_idx").on(
      t.businessId,
      t.customerId,
      t.expiresAt,
    ),
    check(
      "loyalty_points_batches_positive_check",
      sql`${t.pointsOriginal} > 0 AND ${t.pointsRemaining} >= 0`,
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
    /** Positive = earned/restored; negative = redeemed/reversed/expired. Never zero. */
    points: numeric("points", { precision: 12, scale: 2, mode: "number" })
      .notNull(),
    sourceType: varchar("source_type", { length: 20 }).notNull(),
    sourceId: integer("source_id"),
    /** Display semantics: earned | redeemed | expired | reversed | adjusted | bonus. */
    entryType: varchar("entry_type", { length: 20 }),
    /** Balance immediately after this row (auditability). */
    balanceAfter: numeric("balance_after", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
    /** When the points in this row expire (NULL = never). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
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
    index("loyalty_ledger_expiry_idx").on(
      t.businessId,
      t.customerId,
      t.expiresAt,
    ),
    check("loyalty_ledger_points_nonzero", sql`${t.points} <> 0`),
    check(
      "loyalty_ledger_source_valid",
      sql`${t.sourceType} in ('sale_earn','redeem','refund_reversal','manual','expiry','restore')`,
    ),
  ],
);
