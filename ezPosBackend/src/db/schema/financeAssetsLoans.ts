import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
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
import { locations } from "./locations.js";
import { paymentAccounts } from "./paymentAccounts.js";
import { users } from "./users.js";

/**
 * Loans, business assets & depreciation (Finance & Growth Stage 7,
 * approved architecture §8). GL treatment in the posting hooks:
 *   loan disbursed  DR cash / CR 2080 Loans Payable (financing)
 *   repayment       DR 2080 principal + DR 5090 interest / CR cash
 *   asset acquired  DR 1080/1081/1082 by category / CR cash-or-2010 (investing)
 *   depreciation    DR 5100 / CR 1090 accumulated — monthly straight-line,
 *                   idempotent per (asset, period month)
 */

export const loanLenderTypeEnum = pgEnum("loan_lender_type", [
  "bank",
  "mfs",
  "owner",
  "other",
]);

export const loanStatusEnum = pgEnum("loan_status", [
  "active",
  "closed",
  "written_off",
]);

export const assetCategoryEnum = pgEnum("asset_category", [
  "equipment",
  "furniture",
  "vehicle",
  "other",
]);

export const assetStatusEnum = pgEnum("asset_status", [
  "active",
  "sold",
  "written_off",
]);

export const businessLoans = pgTable(
  "business_loans",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    lenderType: loanLenderTypeEnum("lender_type").notNull(),
    lenderName: varchar("lender_name", { length: 120 }).notNull(),
    principal: numeric("principal", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).notNull(),
    /** Annual percentage rate; null for interest-free arrangements. */
    interestRate: numeric("interest_rate", {
      precision: 6,
      scale: 3,
      mode: "string",
    }),
    loanDate: date("loan_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }),
    installmentCount: integer("installment_count"),
    installmentAmount: numeric("installment_amount", {
      precision: 14,
      scale: 2,
      mode: "string",
    }),
    status: loanStatusEnum("status").default("active").notNull(),
    notes: varchar("notes", { length: 500 }),
    journalEntryId: integer("journal_entry_id"),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("business_loans_id_business_uq").on(table.id, table.businessId),
    index("business_loans_business_status_idx").on(
      table.businessId,
      table.status,
    ),
    check(
      "business_loans_principal_positive_check",
      sql`${table.principal} > 0`,
    ),
  ],
);

export const loanRepayments = pgTable(
  "loan_repayments",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    loanId: integer("loan_id").notNull(),
    paymentDate: date("payment_date", { mode: "string" }).notNull(),
    principalAmount: numeric("principal_amount", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).notNull(),
    interestAmount: numeric("interest_amount", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    totalAmount: numeric("total_amount", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).notNull(),
    method: varchar("method", { length: 30 }),
    paymentAccountId: integer("payment_account_id"),
    reference: varchar("reference", { length: 100 }),
    journalEntryId: integer("journal_entry_id"),
    clientUuid: uuid("client_uuid"),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("loan_repayments_client_uuid_unique").on(table.clientUuid),
    index("loan_repayments_loan_idx").on(table.loanId),
    foreignKey({
      columns: [table.loanId, table.businessId],
      foreignColumns: [businessLoans.id, businessLoans.businessId],
      name: "loan_repayments_loan_business_fkey",
    }),
    foreignKey({
      columns: [table.paymentAccountId, table.businessId],
      foreignColumns: [paymentAccounts.id, paymentAccounts.businessId],
      name: "loan_repayments_payment_account_business_fkey",
    }),
    check(
      "loan_repayments_split_check",
      sql`${table.principalAmount} > 0 AND ${table.interestAmount} >= 0 AND ${table.principalAmount} + ${table.interestAmount} = ${table.totalAmount}`,
    ),
  ],
);

export const businessAssets = pgTable(
  "business_assets",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    name: varchar("name", { length: 120 }).notNull(),
    category: assetCategoryEnum("category").notNull(),
    acquiredAt: date("acquired_at", { mode: "string" }).notNull(),
    cost: numeric("cost", { precision: 14, scale: 2, mode: "string" }).notNull(),
    salvageValue: numeric("salvage_value", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    usefulLifeMonths: integer("useful_life_months").notNull(),
    depreciationMethod: varchar("depreciation_method", { length: 20 })
      .default("straight_line")
      .notNull(),
    /** Mirror of Σ depreciation postings. */
    accumulatedDepreciation: numeric("accumulated_depreciation", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    status: assetStatusEnum("status").default("active").notNull(),
    locationId: integer("location_id"),
    notes: varchar("notes", { length: 500 }),
    journalEntryId: integer("journal_entry_id"),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("business_assets_id_business_uq").on(table.id, table.businessId),
    index("business_assets_business_status_idx").on(
      table.businessId,
      table.status,
    ),
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "business_assets_location_business_fkey",
    }),
    check(
      "business_assets_values_check",
      sql`${table.cost} > 0 AND ${table.salvageValue} >= 0 AND ${table.usefulLifeMonths} > 0`,
    ),
  ],
);

export const assetDepreciationPostings = pgTable(
  "asset_depreciation_postings",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    assetId: integer("asset_id").notNull(),
    /** First day of the depreciated month — the idempotency key. */
    periodMonth: date("period_month", { mode: "string" }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2, mode: "string" }).notNull(),
    accumulatedAfter: numeric("accumulated_after", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).notNull(),
    journalEntryId: integer("journal_entry_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // One posting per asset per month.
    uniqueIndex("asset_depreciation_postings_asset_month_unique").on(
      table.assetId,
      table.periodMonth,
    ),
    foreignKey({
      columns: [table.assetId],
      foreignColumns: [businessAssets.id],
      name: "asset_depreciation_postings_asset_fkey",
    }),
    check(
      "asset_depreciation_postings_amount_check",
      sql`${table.amount} >= 0`,
    ),
  ],
);
