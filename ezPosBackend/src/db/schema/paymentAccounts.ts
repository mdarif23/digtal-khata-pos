import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { chartOfAccounts } from "./chartOfAccounts.js";

/**
 * Cash & bank entity (Finance & Growth foundation). Before this table the
 * system had NO bank/MFS balance anywhere — payment methods were bare
 * strings. A payment account is a real store of money (drawer, bank
 * account, bKash/Nagad wallet) mapped to exactly one GL account, so every
 * money movement can post to a balance that reconciles.
 */

export const paymentAccountTypeEnum = pgEnum("payment_account_type", [
  "cash",
  "bank",
  "mfs",
]);

export const paymentAccounts = pgTable(
  "payment_accounts",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    name: varchar("name", { length: 100 }).notNull(),
    type: paymentAccountTypeEnum("type").notNull(),
    /** Gateway/wallet identifier, e.g. "bkash", "sslcommerz", "nagad". */
    provider: varchar("provider", { length: 30 }),
    /** The GL account this account's balance lives on (cash-like). */
    glAccountId: integer("gl_account_id").notNull(),
    currency: varchar("currency", { length: 3 }).default("BDT").notNull(),
    /** Default account for its type — used by posting hooks. */
    isDefault: boolean("is_default").default(false).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    notes: varchar("notes", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("payment_accounts_id_business_uq").on(table.id, table.businessId),
    index("payment_accounts_business_idx").on(table.businessId, table.type),
    // One default per (business, type) among active accounts.
    uniqueIndex("payment_accounts_default_per_type_uq")
      .on(table.businessId, table.type)
      .where(sql`${table.isDefault} = true AND ${table.isActive} = true`),
    // The GL account must belong to the same business.
    foreignKey({
      columns: [table.glAccountId, table.businessId],
      foreignColumns: [chartOfAccounts.id, chartOfAccounts.businessId],
      name: "payment_accounts_gl_account_business_fkey",
    }),
  ],
);
