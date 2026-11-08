import {
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businesses } from "./businesses.js";
import { chartOfAccounts } from "./chartOfAccounts.js";

export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    categoryName: varchar("category_name", { length: 100 }).notNull(),
    description: varchar({ length: 255 }),
    color: varchar({ length: 20 }),
    icon: varchar({ length: 50 }),
    /**
     * Soft archive — categories referenced by expenses are never hard-deleted
     * (historical expense rows keep their category). Archived names free the
     * per-business uniqueness so a fresh active category may reuse the name.
     */
    archivedAt: timestamp("archived_at", { mode: "string" }),
    /**
     * Finance & Growth: the expense account (chart_of_accounts) this
     * category posts to. Nullable — unmapped categories post to the
     * business's "Other Expenses" system account.
     */
    glAccountId: integer("gl_account_id"),
  },
  (table) => [
    index("expense_categories_business_id_idx").on(table.businessId),
    // Per-business uniqueness — two businesses may both define "Rent".
    // Partial: archived categories no longer reserve their name (migration 0039
    // replaced the full unique from 0001).
    uniqueIndex("expense_categories_business_name_active_unique")
      .on(table.businessId, table.categoryName)
      .where(sql`archived_at is null`),
    unique("expense_categories_id_business_uq").on(table.id, table.businessId),
    // The mapped expense account must belong to the same business.
    foreignKey({
      columns: [table.glAccountId, table.businessId],
      foreignColumns: [chartOfAccounts.id, chartOfAccounts.businessId],
      name: "expense_categories_gl_account_business_fkey",
    }),
  ],
);

