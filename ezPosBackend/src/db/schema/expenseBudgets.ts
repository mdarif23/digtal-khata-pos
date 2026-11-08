import {
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businesses } from "./businesses.js";
import { expenseCategories } from "./expenseCategories.js";
import { locations } from "./locations.js";
import { users } from "./users.js";

/**
 * Expense budgets (Phase 6, extended in Stage 7). Plans, not financial
 * records — they are hard-deletable. category_id/location_id NULL means
 * "all categories / locations"; the scope+period uniqueness coalesces NULLs
 * to 0 (plain UNIQUE treats NULLs as distinct). `month` stores the PERIOD
 * START (month / quarter / year start per period_type).
 */
export const expenseBudgets = pgTable(
  "expense_budgets",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    categoryId: integer("category_id"),
    locationId: integer("location_id"),
    month: date("month").notNull(),
    amount: numeric("amount", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    /** monthly (default) | quarterly | yearly. */
    periodType: varchar("period_type", { length: 20 })
      .default("monthly")
      .notNull(),
    /** Utilization % that triggers a budget_alert notification. */
    warningThresholdPercent: numeric("warning_threshold_percent", {
      precision: 5,
      scale: 2,
      mode: "number",
    })
      .default(80)
      .notNull(),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { mode: "string" }).default(
      sql`CURRENT_TIMESTAMP`,
    ),
    updatedAt: timestamp("updated_at", { mode: "string" }).default(
      sql`CURRENT_TIMESTAMP`,
    ),
  },
  (table) => [
    foreignKey({
      columns: [table.categoryId, table.businessId],
      foreignColumns: [expenseCategories.id, expenseCategories.businessId],
      name: "expense_budgets_category_business_fkey",
    }),
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "expense_budgets_location_business_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: "expense_budgets_created_by_users_fk",
    }),
    uniqueIndex("expense_budgets_scope_period_unique").on(
      table.businessId,
      table.periodType,
      sql`coalesce(category_id, 0)`,
      sql`coalesce(location_id, 0)`,
      table.month,
    ),
    index("expense_budgets_business_month_idx").on(table.businessId, table.month),
    check("expense_budgets_amount_check", sql`amount > 0`),
    check(
      "expense_budgets_period_check",
      sql`("period_type" = 'monthly' AND "month" = date_trunc('month', "month")::date)
        OR ("period_type" = 'quarterly' AND "month" = date_trunc('quarter', "month")::date)
        OR ("period_type" = 'yearly' AND "month" = date_trunc('year', "month")::date)`,
    ),
    check(
      "expense_budgets_warning_threshold_check",
      sql`"warning_threshold_percent" > 0 AND "warning_threshold_percent" <= 100`,
    ),
  ],
);
