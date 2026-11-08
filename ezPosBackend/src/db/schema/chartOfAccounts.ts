import {
  type AnyPgColumn,
  boolean,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";

/**
 * Finance & Growth (Phase 0 approved architecture, docs/finance-growth/
 * phase-0-audit-and-architecture.md §7): the chart of accounts is the
 * backbone of the double-entry ledger. Accounts are per-business; ~40 system
 * accounts (is_system) are seeded at Finance activation and can never be
 * deleted or re-coded — only archived. Users may add their own expense
 * accounts (5xxx children) on top.
 */

export const financeAccountTypeEnum = pgEnum("finance_account_type", [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
]);

export const financeNormalBalanceEnum = pgEnum("finance_normal_balance", [
  "debit",
  "credit",
]);

/** Direct-method cash-flow classification for statement building. */
export const financeCashFlowCategoryEnum = pgEnum(
  "finance_cash_flow_category",
  ["none", "operating", "investing", "financing"],
);

export const chartOfAccounts = pgTable(
  "chart_of_accounts",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    /** Stable code within the business, e.g. "1010", "4010". */
    code: varchar("code", { length: 20 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    type: financeAccountTypeEnum("type").notNull(),
    normalBalance: financeNormalBalanceEnum("normal_balance").notNull(),
    /** Seeded system account — protected from edit/delete by the service. */
    isSystem: boolean("is_system").default(false).notNull(),
    /** Cash-equivalent account (drawers, bank, MFS) for cash-flow queries. */
    isCash: boolean("is_cash").default(false).notNull(),
    cashFlowCategory: financeCashFlowCategoryEnum("cash_flow_category")
      .default("none")
      .notNull(),
    /** Optional one-level grouping parent (same business, service-enforced). */
    parentId: integer("parent_id").references(
      (): AnyPgColumn => chartOfAccounts.id,
      { onDelete: "set null" },
    ),
    description: varchar("description", { length: 255 }),
    /** Soft archive — referenced lines keep rendering; code is freed. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("chart_of_accounts_business_code_unique").on(
      table.businessId,
      table.code,
    ),
    // Candidate key so child tables can use composite (id, business_id) FKs.
    unique("chart_of_accounts_id_business_uq").on(table.id, table.businessId),
    index("chart_of_accounts_business_type_idx").on(
      table.businessId,
      table.type,
    ),
    index("chart_of_accounts_business_parent_idx").on(
      table.businessId,
      table.parentId,
    ),
  ],
);

/**
 * Accounting periods (month granularity). Created open on demand by the
 * posting gateway; closing is permission-gated and blocks further posting
 * into the period. Reopening is a separate, audited action.
 */
export const accountingPeriodStatusEnum = pgEnum("accounting_period_status", [
  "open",
  "closed",
]);

export const accountingPeriods = pgTable(
  "accounting_periods",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    status: accountingPeriodStatusEnum("status").default("open").notNull(),
    closedByUserId: integer("closed_by_user_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("accounting_periods_business_start_unique").on(
      table.businessId,
      table.periodStart,
    ),
    index("accounting_periods_business_status_idx").on(
      table.businessId,
      table.status,
    ),
  ],
);
