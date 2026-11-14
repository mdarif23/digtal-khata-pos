import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import {
  accountingPeriods,
  chartOfAccounts,
} from "../db/schema/chartOfAccounts.js";
import { businesses } from "../db/schema/businesses.js";
import {
  journalEntries,
  journalEntryLines,
} from "../db/schema/journalEntries.js";
import { paymentAccounts } from "../db/schema/paymentAccounts.js";
import { registerSessions, registers } from "../db/schema/registers.js";

import type { Tx } from "./audit.js";
import { recordAuditInTx } from "./audit.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../utils/handleError.js";
import {
  assertMoneyAmount,
  businessLocalDate,
  poishaToMoneyString,
  toPoisha,
} from "../utils/money.js";
import { nextDocumentNumber } from "../utils/documentSequence.js";

export type DbOrTx = Tx | typeof db;
export type ChartAccount = typeof chartOfAccounts.$inferSelect;

/**
 * THE DOUBLE-ENTRY POSTING GATEWAY (Finance & Growth foundation).
 *
 * Every journal write in the system goes through this module — operational
 * flows (sales, refunds, expenses, purchases, payroll…) call the posting
 * hooks that wrap `postJournalEntry`, and the finance module exposes manual
 * entries through it. Nothing else may INSERT into journal_entries /
 * journal_entry_lines.
 *
 * Guarantees (see docs/finance-growth/phase-0-audit-and-architecture.md §7):
 *  1. Balance — Σ debits === Σ credits in integer poisha, per entry.
 *  2. Immutability — posted entries are never updated; corrections create
 *     reversal entries (`reverseEntry`).
 *  3. Idempotency — a posted entry is uniquely keyed by
 *     (business_id, source_type, source_id); replaying an event returns the
 *     existing entry instead of double-posting.
 *  4. Period control — entries post only into OPEN accounting periods.
 *  5. Activation — posting is rejected until the business activated the
 *     ledger (businesses.ledger_activated_at) via the opening-balance
 *     wizard.
 */

/** Known journal source types (varchar column — validated here, not DDL). */
export const FINANCE_SOURCE_TYPES = [
  "sale",
  "sale_refund",
  "sale_due_collection",
  "gift_card_issue",
  "purchase_receive",
  "purchase_payment",
  "purchase_return",
  "purchase_cancellation",
  "landed_cost",
  "expense",
  "expense_payment",
  "stock_count",
  "payroll",
  "payroll_advance",
  "payroll_payment",
  "owner_capital",
  "loan",
  "loan_repayment",
  "asset",
  "asset_depreciation",
  "opening",
  "adjustment",
  "manual",
] as const;
export type FinanceSourceType = (typeof FINANCE_SOURCE_TYPES)[number];

export type FinanceCashFlowCategory =
  | "none"
  | "operating"
  | "investing"
  | "financing";

export interface JournalLineInput {
  /** Chart-of-accounts code (e.g. "1010") — resolved per business. */
  accountCode?: string;
  /** Explicit account id (must belong to the business). */
  accountId?: number;
  /** 2dp amount; exactly one of debit/credit must be > 0 per line. */
  debit?: number;
  credit?: number;
  locationId?: number | null;
  description?: string | null;
}

export interface PostJournalEntryInput {
  businessId: number;
  /** Business-local calendar date; defaults to today in the business tz. */
  entryDate?: string;
  memo?: string | null;
  sourceType?: FinanceSourceType | null;
  sourceId?: number | null;
  cashFlowCategory?: FinanceCashFlowCategory;
  /** Hooks post immediately; manual entries may start as drafts. */
  status?: "draft" | "posted";
  lines: JournalLineInput[];
  actorUserId?: number | null;
}

export type PostedEntry = typeof journalEntries.$inferSelect;
export type PostedLine = typeof journalEntryLines.$inferSelect;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/** Ledger go-live marker — hooks skip posting for businesses without it. */
export async function isLedgerActivatedInTx(
  tx: DbOrTx,
  businessId: number,
): Promise<boolean> {
  const [biz] = await tx
    .select({ activatedAt: businesses.ledgerActivatedAt })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return biz?.activatedAt != null;
}

async function requireLedgerActivated(
  tx: DbOrTx,
  businessId: number,
): Promise<void> {
  if (!(await isLedgerActivatedInTx(tx, businessId))) {
    throw new ConflictError(
      "The Finance ledger is not activated for this business. Run the opening-balance activation first.",
    );
  }
}

/** Business timezone for accounting dates (default Asia/Dhaka). */
export async function getBusinessTimezone(
  tx: DbOrTx,
  businessId: number,
): Promise<string> {
  const [biz] = await tx
    .select({ timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return biz?.timezone ?? "Asia/Dhaka";
}

/** Today (business-local) as a ledger entry date. */
export async function todayForBusiness(
  tx: DbOrTx,
  businessId: number,
): Promise<string> {
  const tz = await getBusinessTimezone(tx, businessId);
  return businessLocalDate(new Date(), tz);
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

export async function getAccountByCode(
  tx: DbOrTx,
  businessId: number,
  code: string,
): Promise<ChartAccount | null> {
  const [account] = await tx
    .select()
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.businessId, businessId),
        eq(chartOfAccounts.code, code),
      ),
    )
    .limit(1);
  return account ?? null;
}

/** System accounts are seeded at activation — a missing one is a bug. */
export async function requireAccountByCode(
  tx: DbOrTx,
  businessId: number,
  code: string,
): Promise<ChartAccount> {
  const account = await getAccountByCode(tx, businessId, code);
  if (!account) {
    throw new NotFoundError(
      `Chart of accounts is missing system account ${code} for this business.`,
    );
  }
  return account;
}

export async function requireAccountById(
  tx: DbOrTx,
  businessId: number,
  accountId: number,
): Promise<ChartAccount> {

  const [account] = await tx
    .select()
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.id, accountId),
        eq(chartOfAccounts.businessId, businessId),
      ),
    )
    .limit(1);
  if (!account) {
    throw new NotFoundError(
      `Journal line account ${accountId} does not exist in this business's chart of accounts.`,
    );
  }
  return account;
}

async function getActivePaymentAccount(
  tx: DbOrTx,
  businessId: number,
  paymentAccountId: number,
): Promise<typeof paymentAccounts.$inferSelect | null> {
  const [account] = await tx
    .select()
    .from(paymentAccounts)
    .where(
      and(
        eq(paymentAccounts.id, paymentAccountId),
        eq(paymentAccounts.businessId, businessId),
        eq(paymentAccounts.isActive, true),
      ),
    )
    .limit(1);
  return account ?? null;
}

/**
 * Default cash-like GL account for a payment method, honoring an explicit
 * payment account and the owning register's account before falling back to
 * per-type defaults, then to the seeded system accounts.
 *
 * Sale methods: cash → cash account; bangla_qr/card/sslcommerz → bank.
 * Expense methods: 'Cash' → cash; 'Mobile' → MFS; 'Card' → bank.
 *
 * Returns the GL (chart-of-accounts) account for the journal line AND the
 * payment_accounts.id when the resolution went through a real payment
 * account — callers stamp that id on the operational payment rows (the GL
 * account id itself is NOT a payment_accounts id).
 */
export async function resolveCashAccountForMethod(
  tx: DbOrTx,
  businessId: number,
  method: string,
  opts: {
    paymentAccountId?: number | null;
    registerSessionId?: number | null;
  } = {},
): Promise<{ account: ChartAccount; paymentAccountId: number | null }> {
  const wantedType =
    method === "cash" || method === "Cash"
      ? "cash"
      : method === "Mobile"
        ? "mfs"
        : "bank";

  // 1) Explicit account on the payment row.
  if (opts.paymentAccountId != null) {
    const account = await getActivePaymentAccount(tx, businessId, opts.paymentAccountId);
    if (account) {
      return {
        account: await requireAccountById(tx, businessId, account.glAccountId),
        paymentAccountId: account.id,
      };
    }
  }

  // 2) The drawer's account (via the register session).
  if (opts.registerSessionId != null) {
    const [row] = await tx
      .select({
        paymentAccountId: paymentAccounts.id,
        glAccountId: paymentAccounts.glAccountId,
      })
      .from(registerSessions)
      .innerJoin(registers, eq(registers.id, registerSessions.registerId))
      .innerJoin(
        paymentAccounts,
        eq(paymentAccounts.id, registers.paymentAccountId),
      )
      .where(
        and(
          eq(registerSessions.id, opts.registerSessionId),
          eq(registerSessions.businessId, businessId),
          eq(paymentAccounts.isActive, true),
        ),
      )
      .limit(1);
    if (row) {
      return {
        account: await requireAccountById(tx, businessId, row.glAccountId),
        paymentAccountId: row.paymentAccountId,
      };
    }
  }

  // 3) Default payment account of the wanted type.
  const [defaultPaymentAccount] = await tx
    .select({
      id: paymentAccounts.id,
      glAccountId: paymentAccounts.glAccountId,
    })
    .from(paymentAccounts)
    .where(
      and(
        eq(paymentAccounts.businessId, businessId),
        eq(paymentAccounts.type, wantedType),
        eq(paymentAccounts.isDefault, true),
        eq(paymentAccounts.isActive, true),
      ),
    )
    .limit(1);
  if (defaultPaymentAccount) {
    return {
      account: await requireAccountById(tx, businessId, defaultPaymentAccount.glAccountId),
      paymentAccountId: defaultPaymentAccount.id,
    };
  }

  // 4) Seeded system accounts (no payment account to stamp).
  const fallbackCode = wantedType === "cash" ? "1010" : "1020";
  return { account: await requireAccountByCode(tx, businessId, fallbackCode), paymentAccountId: null };
}

// ---------------------------------------------------------------------------
// Idempotent lookup
// ---------------------------------------------------------------------------

/** The posted entry for a source event, if one already exists. */
export async function findPostedEntryBySource(
  tx: DbOrTx,
  businessId: number,
  sourceType: string,
  sourceId: number,
): Promise<PostedEntry | null> {
  const [entry] = await tx
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.businessId, businessId),
        eq(journalEntries.sourceType, sourceType),
        eq(journalEntries.sourceId, sourceId),
        eq(journalEntries.status, "posted"),
      ),
    )
    .limit(1);
  return entry ?? null;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export function monthBounds(entryDate: string): {
  periodStart: string;
  periodEnd: string;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entryDate);
  if (!match) {
    throw new BadRequestError(
      `Invalid entry date "${entryDate}" (YYYY-MM-DD expected).`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    periodStart: `${entryDate.slice(0, 7)}-01`,
    periodEnd: `${entryDate.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`,
  };
}

/**
 * Get-or-create the accounting period containing entryDate and assert it is
 * open. Returns the period row.
 */
export async function ensureOpenPeriodInTx(
  tx: Tx,
  businessId: number,
  entryDate: string,
): Promise<typeof accountingPeriods.$inferSelect> {
  const { periodStart, periodEnd } = monthBounds(entryDate);
  const [existing] = await tx
    .select()
    .from(accountingPeriods)
    .where(
      and(
        eq(accountingPeriods.businessId, businessId),
        eq(accountingPeriods.periodStart, periodStart),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.status === "closed") {
      throw new ConflictError(
        `Accounting period ${periodStart.slice(0, 7)} is closed; posting into it is not allowed.`,
      );
    }
    return existing;
  }
  const [created] = await tx
    .insert(accountingPeriods)
    .values({ businessId, periodStart, periodEnd })
    .returning();
  if (!created) {
    throw new Error("Failed to create the accounting period.");
  }
  return created;
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

function formatJournalEntryNumber(year: number, number: number): string {
  return `JE-${year}-${String(number).padStart(6, "0")}`;
}

/**
 * Post (or draft) a balanced journal entry. See module docblock for the
 * guarantees. When sourceType+sourceId are supplied and a posted entry
 * already exists for the event, the EXISTING entry is returned unchanged —
 * callers can invoke posting hooks unconditionally inside transactions.
 */
export async function postJournalEntry(
  tx: Tx,
  input: PostJournalEntryInput,
): Promise<{ entry: PostedEntry; lines: PostedLine[]; reused: boolean }> {
  const { businessId } = input;

  if (
    input.sourceType != null &&
    !(FINANCE_SOURCE_TYPES as readonly string[]).includes(input.sourceType)
  ) {
    throw new BadRequestError(
      `Unknown journal source type "${input.sourceType}".`,
    );
  }
  if (!input.lines || input.lines.length === 0) {
    throw new BadRequestError("A journal entry needs at least two lines.");
  }

  // Idempotent replay: return the already-posted entry for this event.
  if (
    input.sourceType != null &&
    input.sourceId != null &&
    input.status !== "draft"
  ) {
    const existing = await findPostedEntryBySource(
      tx,
      businessId,
      input.sourceType,
      input.sourceId,
    );
    if (existing) {
      const lines = await tx
        .select()
        .from(journalEntryLines)
        .where(eq(journalEntryLines.entryId, existing.id));
      return { entry: existing, lines, reused: true };
    }
  }

  await requireLedgerActivated(tx, businessId);

  // Resolve accounts and normalize amounts to poisha.
  const resolvedLines: {
    accountId: number;
    debitPoisha: number;
    creditPoisha: number;
    locationId: number | null;
    description: string | null;
  }[] = [];
  for (const [index, line] of input.lines.entries()) {
    if (line.accountId != null && line.accountCode != null) {
      throw new BadRequestError(
        "Journal line must specify either accountId or accountCode, not both.",
      );
    }
    const account =
      line.accountId != null
        ? await requireAccountById(tx, businessId, line.accountId)
        : await requireAccountByCode(tx, businessId, line.accountCode!);
    const hasDebit = line.debit != null && line.debit > 0;
    const hasCredit = line.credit != null && line.credit > 0;
    if (hasDebit && hasCredit) {
      throw new BadRequestError(
        `Journal line ${index + 1} cannot have both debit and credit.`,
      );
    }
    if (!hasDebit && !hasCredit) {
      throw new BadRequestError(
        `Journal line ${index + 1} needs a debit or a credit amount.`,
      );
    }
    const debitPoisha =
      line.debit != null
        ? assertMoneyAmount(line.debit, `Journal line ${index + 1} debit`)
        : 0;
    const creditPoisha =
      line.credit != null
        ? assertMoneyAmount(line.credit, `Journal line ${index + 1} credit`)
        : 0;
    resolvedLines.push({
      accountId: account.id,
      debitPoisha,
      creditPoisha,
      locationId: line.locationId ?? null,
      description: line.description ?? null,
    });
  }

  const totalDebitPoisha = resolvedLines.reduce(
    (sum, l) => sum + l.debitPoisha,
    0,
  );
  const totalCreditPoisha = resolvedLines.reduce(
    (sum, l) => sum + l.creditPoisha,
    0,
  );
  if (totalDebitPoisha !== totalCreditPoisha) {
    throw new ConflictError(
      `Journal entry does not balance: debits ${poishaToMoneyString(totalDebitPoisha)} ≠ credits ${poishaToMoneyString(totalCreditPoisha)}.`,
    );
  }

  const entryDate = input.entryDate ?? (await todayForBusiness(tx, businessId));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
    throw new BadRequestError(
      `Invalid entry date "${entryDate}" (YYYY-MM-DD expected).`,
    );
  }

  const status = input.status ?? "posted";
  if (status === "posted") {
    await ensureOpenPeriodInTx(tx, businessId, entryDate);
  }

  const year = Number(entryDate.slice(0, 4));
  const docNumber = await nextDocumentNumber(tx, businessId, "journal_entry");

  const [entry] = await tx
    .insert(journalEntries)
    .values({
      businessId,
      entryNo: formatJournalEntryNumber(year, docNumber),
      entryDate,
      memo: input.memo ?? null,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      cashFlowCategory: input.cashFlowCategory ?? "none",
      status,
      postedAt: status === "posted" ? new Date() : null,
      postedByUserId: status === "posted" ? (input.actorUserId ?? null) : null,
      createdByUserId: input.actorUserId ?? null,
    })
    .returning();
  if (!entry) {
    throw new Error("Failed to create the journal entry.");
  }

  const insertedLines = await tx
    .insert(journalEntryLines)
    .values(
      resolvedLines.map((line) => ({
        entryId: entry.id,
        businessId,
        accountId: line.accountId,
        debit: poishaToMoneyString(line.debitPoisha),
        credit: poishaToMoneyString(line.creditPoisha),
        locationId: line.locationId,
        description: line.description,
      })),
    )
    .returning();

  await recordAuditInTx(tx, {
    businessId,
    actorUserId: input.actorUserId ?? null,
    action:
      status === "posted"
        ? "finance.journal.posted"
        : "finance.journal.drafted",
    entityType: "journal_entry",
    entityId: entry.id,
    metadata: {
      entryNo: entry.entryNo,
      entryDate,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      total: poishaToMoneyString(totalDebitPoisha),
      lines: resolvedLines.length,
    },
  });

  return { entry, lines: insertedLines, reused: false };
}

// ---------------------------------------------------------------------------
// Reversals
// ---------------------------------------------------------------------------

/**
 * Reverse a posted entry: a new balanced entry with swapped lines is posted
 * and the original is marked 'reversed'. Posted entries themselves are never
 * edited. Reversal entries have no source idempotency key (sourceId NULL) so
 * they can never collide with the source-posted unique index.
 */
export async function reverseEntry(
  tx: Tx,
  params: {
    businessId: number;
    entryId: number;
    reason: string;
    actorUserId?: number | null;
    entryDate?: string;
  },
): Promise<{
  entry: PostedEntry;
  lines: PostedLine[];
  reversedEntry: PostedEntry;
}> {
  const { businessId, entryId } = params;
  if (!params.reason || !params.reason.trim()) {
    throw new BadRequestError("A reversal reason is required.");
  }

  await requireLedgerActivated(tx, businessId);

  const [original] = await tx
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.id, entryId),
        eq(journalEntries.businessId, businessId),
      ),
    )
    .limit(1);
  if (!original) {
    throw new NotFoundError("Journal entry not found.");
  }
  if (original.status !== "posted") {
    throw new ConflictError(
      `Only posted entries can be reversed (entry ${original.entryNo} is ${original.status}).`,
    );
  }
  const [existingReversal] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.reversalOfEntryId, entryId),
        eq(journalEntries.businessId, businessId),
        eq(journalEntries.status, "posted"),
      ),
    )
    .limit(1);
  if (existingReversal) {
    throw new ConflictError(
      "This entry has already been reversed. Post a replacement entry instead.",
    );
  }

  const originalLines = await tx
    .select()
    .from(journalEntryLines)
    .where(eq(journalEntryLines.entryId, entryId));

  const entryDate = params.entryDate ?? (await todayForBusiness(tx, businessId));
  await ensureOpenPeriodInTx(tx, businessId, entryDate);

  const year = Number(entryDate.slice(0, 4));
  const docNumber = await nextDocumentNumber(tx, businessId, "journal_entry");
  const [reversal] = await tx
    .insert(journalEntries)
    .values({
      businessId,
      entryNo: formatJournalEntryNumber(year, docNumber),
      entryDate,
      memo: `Reversal of ${original.entryNo}: ${params.reason.trim()}`,
      sourceType: "reversal" as FinanceSourceType,
      cashFlowCategory: original.cashFlowCategory,
      status: "posted",
      reversalOfEntryId: original.id,
      reversalReason: params.reason.trim(),
      postedAt: new Date(),
      postedByUserId: params.actorUserId ?? null,
      createdByUserId: params.actorUserId ?? null,
    })
    .returning();
  if (!reversal) {
    throw new Error("Failed to create the reversal entry.");
  }

  await tx.insert(journalEntryLines).values(
    originalLines.map((line) => ({
      entryId: reversal.id,
      businessId,
      accountId: line.accountId,
      // Swap the sides — a reversal exactly negates the original entry.
      debit: line.credit,
      credit: line.debit,
      locationId: line.locationId,
      description: line.description
        ? `Reversal: ${line.description}`
        : `Reversal of ${original.entryNo}`,
    })),
  );

  const [updatedOriginal] = await tx
    .update(journalEntries)
    .set({ status: "reversed", updatedAt: new Date() })
    .where(
      and(
        eq(journalEntries.id, entryId),
        eq(journalEntries.businessId, businessId),
      ),
    )
    .returning();
  if (!updatedOriginal) {
    throw new Error("Failed to mark the original entry as reversed.");
  }

  await recordAuditInTx(tx, {
    businessId,
    actorUserId: params.actorUserId ?? null,
    action: "finance.journal.reversed",
    entityType: "journal_entry",
    entityId: reversal.id,
    metadata: {
      reversalOf: original.entryNo,
      reason: params.reason.trim(),
    },
  });

  return {
    entry: reversal,
    lines: await tx
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.entryId, reversal.id)),
    reversedEntry: updatedOriginal,
  };
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export interface AccountBalance {
  accountId: number;
  code: string;
  name: string;
  type: string;
  normalBalance: string;
  /** Σ debit − Σ credit across the requested window (money string). */
  balance: string;
}

/**
 * Account balances as of (optionally limited to) a date window.
 *
 * Balances include POSTED entries and REVERSED originals: a reversal posts
 * counter-lines that exactly cancel the original, so both must count for
 * the net to be zero. Drafts never appear.
 */
export async function getAccountBalances(
  tx: DbOrTx,
  businessId: number,
  opts: { fromDate?: string; toDate?: string } = {},
): Promise<AccountBalance[]> {
  const conditions = [eq(journalEntryLines.businessId, businessId)];
  if (opts.fromDate) {
    conditions.push(gte(journalEntries.entryDate, opts.fromDate));
  }
  if (opts.toDate) {
    conditions.push(lte(journalEntries.entryDate, opts.toDate));
  }
  const rows = await tx
    .select({
      accountId: chartOfAccounts.id,
      code: chartOfAccounts.code,
      name: chartOfAccounts.name,
      type: chartOfAccounts.type,
      normalBalance: chartOfAccounts.normalBalance,
      debit: sql<string>`coalesce(sum(${journalEntryLines.debit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(
      journalEntries,
      and(
        eq(journalEntries.id, journalEntryLines.entryId),
        inArray(journalEntries.status, ["posted", "reversed"]),
      ),
    )
    .innerJoin(
      chartOfAccounts,
      eq(chartOfAccounts.id, journalEntryLines.accountId),
    )
    .where(and(...conditions))
    .groupBy(
      chartOfAccounts.id,
      chartOfAccounts.code,
      chartOfAccounts.name,
      chartOfAccounts.type,
      chartOfAccounts.normalBalance,
    )
    .orderBy(chartOfAccounts.code);

  return rows.map((row) => {
    const balancePoisha =
      toPoisha(Number(row.debit)) - toPoisha(Number(row.credit));
    return {
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      type: row.type,
      normalBalance: row.normalBalance,
      balance: poishaToMoneyString(balancePoisha),
    };
  });
}
