import { sql } from "drizzle-orm";
import {
  uniqueIndex,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { users } from "./users.js";

/**
 * Sales team & BI (Phase 5 — master prompt Feature 13). Commission is a
 * LEDGER: per-sale entries with a forward-only lifecycle; refunds write
 * NEGATIVE reversed entries instead of deleting history. Unpaid commission
 * is never booked as an expense (payment posting is manual for v1).
 */

export const commissionEntryStatusEnum = pgEnum("commission_entry_status", [
  "calculated",
  "pending",
  "approved",
  "payable",
  "paid",
  "reversed",
]);

export const commissionRules = pgTable(
  "commission_rules",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    /** percentage_of_sales | fixed_per_sale | percentage_of_profit */
    calcMethod: varchar("calc_method", { length: 30 }).notNull(),
    /** percent (0-100) or flat amount depending on method. */
    rate: numeric("rate", { precision: 14, scale: 4, mode: "number" }).notNull(),
    /** NULL = whole business; category/product narrow eligibility. */
    categoryId: integer("category_id"),
    productId: integer("product_id"),
    /** NULL = every salesperson. */
    userId: integer("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("commission_rules_business_idx").on(t.businessId, t.isActive),
    check(
      "commission_rules_method_check",
      sql`${t.calcMethod} IN ('percentage_of_sales', 'fixed_per_sale', 'percentage_of_profit')`,
    ),
    check("commission_rules_rate_check", sql`${t.rate} >= 0`),
  ],
);

export const commissionEntries = pgTable(
  "commission_entries",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    saleId: integer("sale_id").notNull(),
    salespersonUserId: integer("salesperson_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ruleId: integer("rule_id").notNull(),
    ruleNameSnapshot: varchar("rule_name_snapshot", { length: 120 }).notNull(),
    calcMethod: varchar("calc_method", { length: 30 }).notNull(),
    rate: numeric("rate", { precision: 14, scale: 4, mode: "number" }).notNull(),
    /** The eligible amount the rate applied to (snapshot). */
    baseAmount: numeric("base_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    }).notNull(),
    /** Signed: positive = earned, negative = reversal. */
    amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
    status: commissionEntryStatusEnum("status").notNull().default("pending"),
    /** Refund linkage for reversed entries. */
    refundId: integer("refund_id"),
    reason: text("reason"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("commission_entries_sale_user_rule_uq")
      .on(t.businessId, t.saleId, t.salespersonUserId, t.ruleId)
      .where(sql`${t.refundId} IS NULL AND ${t.status} <> 'reversed'`),
    uniqueIndex("commission_entries_reversal_uq")
      .on(t.businessId, t.saleId, t.salespersonUserId, t.ruleId, t.refundId)
      .where(sql`${t.refundId} IS NOT NULL`),
    index("commission_entries_business_user_idx").on(
      t.businessId,
      t.salespersonUserId,
      t.status,
    ),
    index("commission_entries_sale_idx").on(t.saleId),
    check(
      "commission_entries_method_check",
      sql`${t.calcMethod} IN ('percentage_of_sales', 'fixed_per_sale', 'percentage_of_profit')`,
    ),
  ],
);

export const salesTargets = pgTable(
  "sales_targets",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** daily | weekly | monthly | custom */
    periodType: varchar("period_type", { length: 10 }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    targetAmount: numeric("target_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    }).notNull(),
    createdBy: integer("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("sales_targets_user_period_uq").on(
      t.businessId,
      t.userId,
      t.periodStart,
      t.periodEnd,
    ),
    index("sales_targets_business_idx").on(t.businessId, t.periodEnd),
    check(
      "sales_targets_period_check",
      sql`${t.periodType} IN ('daily', 'weekly', 'monthly', 'custom') AND ${t.targetAmount} >= 0`,
    ),
    check("sales_targets_range_check", sql`${t.periodEnd} >= ${t.periodStart}`),
  ],
);
