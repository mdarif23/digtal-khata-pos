import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { paymentAccounts } from "./paymentAccounts.js";
import { users } from "./users.js";

/**
 * Owner finance (Finance & Growth Stage 4, approved architecture §8).
 *
 * owner_profiles — multiple business owners; ownership_percent is
 * descriptive and deliberately NOT assumed to equal contribution shares.
 * capital_transactions — investments, withdrawals (capital repayment) and
 * profit distributions; every row posts to the GL:
 *   investment    DR cash / CR 3010 Owner Contributions
 *   withdrawal    DR 3020 Owner Drawings / CR cash
 *   distribution  DR 3020 Owner Drawings / CR cash
 * profit_allocations + lines — DESIGNATION of distributable profit. An
 * allocation is not a cash movement and posts no journal entry; realizing
 * an owner_distribution line creates an actual capital transaction.
 */

export const capitalTransactionTypeEnum = pgEnum("capital_transaction_type", [
  "investment",
  "withdrawal",
  "distribution",
]);

export const profitAllocationStatusEnum = pgEnum("profit_allocation_status", [
  "confirmed",
  "reversed",
]);

export const profitAllocationCategoryEnum = pgEnum(
  "profit_allocation_category",
  [
    "reinvestment",
    "owner_distribution",
    "emergency_reserve",
    "expansion",
    "debt_repayment",
    "other",
  ],
);

export const ownerProfiles = pgTable(
  "owner_profiles",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    /** Platform user when the owner logs in; null for book-only owners. */
    userId: integer("user_id").references(() => users.id),
    name: varchar("name", { length: 120 }).notNull(),
    phone: varchar("phone", { length: 30 }),
    email: varchar("email", { length: 255 }),
    /** Descriptive share of the business (0-100, 2dp). */
    ownershipPercent: numeric("ownership_percent", {
      precision: 5,
      scale: 2,
      mode: "string",
    }),
    isActive: boolean("is_active").default(true).notNull(),
    notes: varchar("notes", { length: 500 }),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // One ACTIVE profile per platform user per business (null-user rows
    // exempt). Declared in migration 0054 as a partial unique index.
    uniqueIndex("owner_profiles_active_user_unique")
      .on(table.businessId, table.userId)
      .where(sql`${table.isActive} = true AND ${table.userId} IS NOT NULL`),
    // Candidate key for the composite FK from capital_transactions.
    uniqueIndex("owner_profiles_id_business_uq").on(table.id, table.businessId),
    index("owner_profiles_business_idx").on(table.businessId, table.isActive),
  ],
);

export const capitalTransactions = pgTable(
  "capital_transactions",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    ownerProfileId: integer("owner_profile_id").notNull(),
    type: capitalTransactionTypeEnum("type").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2, mode: "string" }).notNull(),
    txnDate: date("txn_date", { mode: "string" }).notNull(),
    paymentAccountId: integer("payment_account_id"),
    method: varchar("method", { length: 30 }),
    sourceOfFunds: varchar("source_of_funds", { length: 120 }),
    reference: varchar("reference", { length: 100 }),
    description: varchar("description", { length: 500 }),
    attachmentUrl: varchar("attachment_url", { length: 500 }),
    journalEntryId: integer("journal_entry_id"),
    /** Client idempotency for retried submissions. */
    clientUuid: uuid("client_uuid"),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("capital_transactions_id_business_uq").on(
      table.id,
      table.businessId,
    ),
    uniqueIndex("capital_transactions_client_uuid_unique").on(
      table.clientUuid,
    ),
    index("capital_transactions_business_date_idx").on(
      table.businessId,
      table.txnDate,
    ),
    index("capital_transactions_business_owner_idx").on(
      table.businessId,
      table.ownerProfileId,
      table.txnDate,
    ),
    foreignKey({
      columns: [table.ownerProfileId, table.businessId],
      foreignColumns: [ownerProfiles.id, ownerProfiles.businessId],
      name: "capital_transactions_owner_business_fkey",
    }),
    foreignKey({
      columns: [table.paymentAccountId, table.businessId],
      foreignColumns: [paymentAccounts.id, paymentAccounts.businessId],
      name: "capital_transactions_payment_account_business_fkey",
    }),
    check(
      "capital_transactions_amount_positive_check",
      sql`${table.amount} > 0`,
    ),
  ],
);

export const profitAllocations = pgTable(
  "profit_allocations",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    periodLabel: varchar("period_label", { length: 60 }),
    /** Snapshot of the verified figures the allocation was based on. */
    basisMetrics: jsonb("basis_metrics").default({}).notNull(),
    totalDistributable: numeric("total_distributable", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).notNull(),
    totalAllocated: numeric("total_allocated", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).notNull(),
    status: profitAllocationStatusEnum("status").default("confirmed").notNull(),
    reversalReason: varchar("reversal_reason", { length: 500 }),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Candidate key for the composite FK from profit_allocation_lines.
    uniqueIndex("profit_allocations_id_business_uq").on(
      table.id,
      table.businessId,
    ),
    index("profit_allocations_business_period_idx").on(
      table.businessId,
      table.periodStart,
      table.periodEnd,
    ),
    check(
      "profit_allocations_period_order_check",
      sql`${table.periodEnd} >= ${table.periodStart}`,
    ),
  ],
);

export const profitAllocationLines = pgTable(
  "profit_allocation_lines",
  {
    id: serial("id").primaryKey().notNull(),
    allocationId: integer("allocation_id").notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    category: profitAllocationCategoryEnum("category").notNull(),
    /** 'percent' (of distributable) or 'fixed' (amount). */
    basisType: varchar("basis_type", { length: 10 }).notNull(),
    basisValue: numeric("basis_value", { precision: 9, scale: 4, mode: "string" }),
    amount: numeric("amount", { precision: 14, scale: 2, mode: "string" }).notNull(),
    realizedAmount: numeric("realized_amount", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    realizedAt: timestamp("realized_at", { withTimezone: true }),
    realizedReference: varchar("realized_reference", { length: 100 }),
    realizedCapitalTransactionId: integer("realized_capital_transaction_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("profit_allocation_lines_allocation_idx").on(table.allocationId),
    foreignKey({
      columns: [table.allocationId, table.businessId],
      foreignColumns: [profitAllocations.id, profitAllocations.businessId],
      name: "profit_allocation_lines_allocation_business_fkey",
    }),
    foreignKey({
      columns: [table.realizedCapitalTransactionId],
      foreignColumns: [capitalTransactions.id],
      name: "profit_allocation_lines_capital_txn_fkey",
    }),
    check(
      "profit_allocation_lines_amount_nonnegative_check",
      sql`${table.amount} >= 0 AND ${table.realizedAmount} >= 0`,
    ),
    check(
      "profit_allocation_lines_basis_check",
      sql`(${table.basisType} = 'percent' AND ${table.basisValue} IS NOT NULL) OR (${table.basisType} = 'fixed')`,
    ),
  ],
);
