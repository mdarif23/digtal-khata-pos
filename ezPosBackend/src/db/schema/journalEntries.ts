import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { chartOfAccounts } from "./chartOfAccounts.js";
import { locations } from "./locations.js";
import { users } from "./users.js";

/**
 * The double-entry journal (Finance & Growth foundation, approved schema
 * docs/finance-growth/phase-0-audit-and-architecture.md §7/§8).
 *
 * Invariants enforced here and in src/services/ledger.ts (the only write
 * path):
 *  - every POSTED entry balances: Σ debits = Σ credits (poisha integers);
 *  - posted entries are immutable — corrections use reversal entries
 *    (status 'reversed' + reversal_of_entry_id) or a replacement entry;
 *  - idempotent posting: the partial unique index below makes it
 *    impossible for the same (business, source_type, source_id) event to
 *    produce two posted entries, so replayed hooks can never double-post;
 *  - drafts exist only for manual/adjustment entries and may be edited
 *    until posted.
 *
 * sourceType is a varchar (not an enum) so later finance phases (owner
 * capital, payroll, loans) add sources without a migration; the service
 * validates against FINANCE_SOURCE_TYPES.
 */

export const journalEntryStatusEnum = pgEnum("journal_entry_status", [
  "draft",
  "posted",
  "reversed",
]);

export const journalCashFlowCategoryEnum = pgEnum(
  "journal_cash_flow_category",
  ["none", "operating", "investing", "financing"],
);

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    /** JE-YYYY-000001 via document_sequences key "journal_entry". */
    entryNo: varchar("entry_no", { length: 30 }).notNull(),
    /** Accounting date (business-local) — drives period assignment. */
    entryDate: date("entry_date", { mode: "string" }).notNull(),
    memo: text(),
    sourceType: varchar("source_type", { length: 40 }),
    sourceId: integer("source_id"),
    /** Cash-flow classification for direct-method statement building. */
    cashFlowCategory: journalCashFlowCategoryEnum("cash_flow_category")
      .default("none")
      .notNull(),
    status: journalEntryStatusEnum("status").default("draft").notNull(),
    /** Set when this entry reverses an earlier posted entry. */
    reversalOfEntryId: integer("reversal_of_entry_id").references(
      (): AnyPgColumn => journalEntries.id,
    ),
    reversalReason: text("reversal_reason"),
    postedByUserId: integer("posted_by_user_id").references(() => users.id),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("journal_entries_business_entry_no_unique").on(
      table.businessId,
      table.entryNo,
    ),
    unique("journal_entries_id_business_uq").on(table.id, table.businessId),
    // Idempotent posting: one posted entry per source document event.
    uniqueIndex("journal_entries_source_posted_uq")
      .on(table.businessId, table.sourceType, table.sourceId)
      .where(
        sql`${table.status} = 'posted' AND ${table.sourceType} IS NOT NULL AND ${table.sourceId} IS NOT NULL`,
      ),
    index("journal_entries_business_date_idx").on(
      table.businessId,
      table.entryDate,
    ),
    index("journal_entries_business_status_idx").on(
      table.businessId,
      table.status,
    ),
    index("journal_entries_reversal_of_idx").on(table.reversalOfEntryId),
    check(
      "journal_entries_reversal_reason_check",
      sql`${table.reversalOfEntryId} IS NULL OR ${table.reversalReason} IS NOT NULL`,
    ),
  ],
);

/**
 * Journal lines. debit/credit are numeric(14,2) mapped as STRINGS — the
 * financial spine must never cross a JS-float boundary; all arithmetic is
 * done in SQL or integer poisha at the service edge.
 */
export const journalEntryLines = pgTable(
  "journal_entry_lines",
  {
    id: serial("id").primaryKey().notNull(),
    entryId: integer("entry_id").notNull(),
    // Denormalized for per-account balance aggregation without a join.
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    accountId: integer("account_id").notNull(),
    debit: numeric("debit", { precision: 14, scale: 2, mode: "string" }).notNull(),
    credit: numeric("credit", { precision: 14, scale: 2, mode: "string" }).notNull(),
    /** Optional location dimension (composite-FK guarded, nullable). */
    locationId: integer("location_id"),
    description: varchar("description", { length: 255 }),
  },
  (table) => [
    index("journal_entry_lines_entry_idx").on(table.entryId),
    index("journal_entry_lines_business_account_idx").on(
      table.businessId,
      table.accountId,
    ),
    unique("journal_entry_lines_id_business_uq").on(table.id, table.businessId),
    foreignKey({
      columns: [table.entryId, table.businessId],
      foreignColumns: [journalEntries.id, journalEntries.businessId],
      name: "journal_entry_lines_entry_business_fkey",
    }),
    foreignKey({
      columns: [table.accountId, table.businessId],
      foreignColumns: [chartOfAccounts.id, chartOfAccounts.businessId],
      name: "journal_entry_lines_account_business_fkey",
    }),
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "journal_entry_lines_location_business_fkey",
    }),
    check(
      "journal_entry_lines_amounts_check",
      sql`${table.debit} >= 0 AND ${table.credit} >= 0 AND (${table.debit} = 0) <> (${table.credit} = 0)`,
    ),
  ],
);
