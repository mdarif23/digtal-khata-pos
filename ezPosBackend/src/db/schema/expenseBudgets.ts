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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businesses } from "./businesses.js";
import { expenseCategories } from "./expenseCategories.js";
import { locations } from "./locations.js";
import { users } from "./users.js";

/**
 * Monthly expense budgets (Phase 6). Plans, not financial records — they are
 * hard-deletable. category_id/location_id NULL means "all categories /
 * locations"; the scope+month uniqueness coalesces NULLs to 0 (plain UNIQUE
 * treats NULLs as distinct). `month` is always the first day of the month.
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
    uniqueIndex("expense_budgets_scope_month_unique").on(
      table.businessId,
      sql`coalesce(category_id, 0)`,
      sql`coalesce(location_id, 0)`,
      table.month,
    ),
    index("expense_budgets_business_month_idx").on(table.businessId, table.month),
    check("expense_budgets_amount_check", sql`amount > 0`),
    check(
      "expense_budgets_month_check",
      sql`month = date_trunc('month', month)::date`,
    ),
  ],
);
