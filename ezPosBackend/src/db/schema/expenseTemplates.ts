import {
  boolean,
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
import { saleChannelEnum } from "./commerceEnums.js";

/**
 * Recurring expense definitions (Phase 6). Generation is a transactional
 * state machine: the same transaction that inserts the expense advances
 * next_generation_date under a row lock, so retries can never duplicate a
 * period. Generated expenses are ALWAYS created unpaid — nothing here can
 * settle them.
 */
export const expenseTemplates = pgTable(
  "expense_templates",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    title: varchar({ length: 255 }).notNull(),
    amount: numeric("amount", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).notNull(),
    categoryId: integer("category_id"),
    paymentMethod: varchar("payment_method", { length: 50 }).notNull(),
    payee: varchar({ length: 150 }),
    note: varchar(),
    locationId: integer("location_id"),
    channel: saleChannelEnum("channel"),
    /** 'weekly' | 'monthly' | 'yearly' */
    frequency: varchar({ length: 10 }).notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    nextGenerationDate: date("next_generation_date").notNull(),
    lastGeneratedDate: date("last_generated_date"),
    isActive: boolean("is_active").notNull().default(true),
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
      name: "expense_templates_category_business_fkey",
    }),
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "expense_templates_location_business_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: "expense_templates_created_by_users_fk",
    }),
    index("expense_templates_business_due_idx").on(
      table.businessId,
      table.nextGenerationDate,
    ),
    uniqueIndex("expense_templates_id_business_uq").on(
      table.id,
      table.businessId,
    ),
    check("expense_templates_amount_check", sql`amount > 0`),
    check(
      "expense_templates_frequency_check",
      sql`frequency in ('weekly', 'monthly', 'yearly')`,
    ),
    check(
      "expense_templates_payment_method_check",
      sql`payment_method in ('Cash', 'Mobile', 'Card')`,
    ),
  ],
);
