import { and, asc, count, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { accountingPeriods } from "../../db/schema/chartOfAccounts.js";
import { chartOfAccounts } from "../../db/schema/chartOfAccounts.js";
import { businesses } from "../../db/schema/businesses.js";
import { journalEntries, journalEntryLines } from "../../db/schema/journalEntries.js";
import { paymentAccounts } from "../../db/schema/paymentAccounts.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { recordAuditInTx, recordAudit } from "../../services/audit.js";
import type { Tx } from "../../services/audit.js";
import {
  ensureOpenPeriodInTx,
  getAccountBalances,
  postJournalEntry,
  reverseEntry as reverseEntryInLedger,
  todayForBusiness,
} from "../../services/ledger.js";
import {
  ensureChartOfAccountsInTx,
  ensureDefaultPaymentAccountsInTx,
} from "./finance.coa.js";
import type {
  ActivateFinanceInput,
  CreateAccountInput,
  CreateJournalEntryInput,
  CreatePaymentAccountInput,
  ListEntriesQuery,
  ReverseEntryInput,
  UpdateAccountInput,
  UpdateDraftEntryInput,
  UpdatePaymentAccountInput,
} from "./finance.schema.js";

type AccountRow = typeof chartOfAccounts.$inferSelect;
type PaymentAccountRow = typeof paymentAccounts.$inferSelect;

// ---------------------------------------------------------------------------
// Status & activation
// ---------------------------------------------------------------------------

export async function getFinanceStatus(businessId: number) {
  const [biz] = await db
    .select({ activatedAt: businesses.ledgerActivatedAt })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!biz) throw new NotFoundError("Business not found.");

  const [accounts] = await db
    .select({ value: count() })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.businessId, businessId));
  const [paymentAccountCount] = await db
    .select({ value: count() })
    .from(paymentAccounts)
    .where(eq(paymentAccounts.businessId, businessId));
  const [entries] = await db
    .select({ value: count() })
    .from(journalEntries)
    .where(eq(journalEntries.businessId, businessId));

  return {
    activated: biz.activatedAt != null,
    activatedAt: biz.activatedAt,
    accountCount: accounts?.value ?? 0,
    paymentAccountCount: paymentAccountCount?.value ?? 0,
    journalEntryCount: entries?.value ?? 0,
  };
}

/**
 * Finance activation (opening-balance wizard, architecture §7.7):
 * seeds the system chart of accounts, creates default payment accounts,
 * posts one `opening` journal entry whose balancing plug lands on Retained
 * Earnings, and stamps businesses.ledger_activated_at. Idempotence: a
 * second activation attempt is rejected — the ledger is never re-opened
 * through this path.
 */
export async function activateFinance(
  businessId: number,
  input: ActivateFinanceInput,
  actorUserId: number,
) {
  const [biz] = await db
    .select({ activatedAt: businesses.ledgerActivatedAt })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!biz) throw new NotFoundError("Business not found.");
  if (biz.activatedAt != null) {
    throw new ConflictError(
      "The Finance ledger is already activated for this business.",
    );
  }

  return db.transaction(async (tx) => {
    // Stamp activation FIRST (same transaction — a failed posting rolls the
    // stamp back): the posting gateway refuses journal writes for businesses
    // without the marker, including this opening entry.
    const activatedAt = new Date();
    await tx
      .update(businesses)
      .set({ ledgerActivatedAt: activatedAt, updatedAt: activatedAt })
      .where(eq(businesses.id, businessId));

    await ensureChartOfAccountsInTx(tx, businessId);

    // Payment accounts from the wizard (first of each type becomes default)…
    const providedTypes = new Set<string>();
    const createdPaymentAccounts: PaymentAccountRow[] = [];
    for (const account of input.accounts) {
      const gl = await requireAccountByCode(tx, businessId, accountTypeGlCode(account.type));
      const [created] = await tx
        .insert(paymentAccounts)
        .values({
          businessId,
          name: account.name,
          type: account.type,
          provider: account.provider ?? null,
          glAccountId: gl.id,
          isDefault: !providedTypes.has(account.type),
          notes: null,
        })
        .returning();
      if (!created) {
        throw new Error("Failed to create the opening payment account.");
      }
      providedTypes.add(account.type);
      createdPaymentAccounts.push(created);
    }
    // …then fill any missing type with a zero-balance default.
    await ensureDefaultPaymentAccountsInTx(tx, businessId, {
      cash: !providedTypes.has("cash"),
      bank: !providedTypes.has("bank"),
      mfs: !providedTypes.has("mfs"),
    });

    // Opening entry: assets on the left, liabilities/equity on the right,
    // the remainder plugs into Retained Earnings (pre-ledger history).
    const lines: Parameters<typeof postJournalEntry>[1]["lines"] = [];
    for (const account of input.accounts) {
      if (account.openingBalance > 0) {
        const gl = await requireAccountByCode(tx, businessId, accountTypeGlCode(account.type));
        lines.push({
          accountCode: gl.code,
          debit: account.openingBalance,
          description: `Opening balance — ${account.name}`,
        });
      }
    }
    if (input.inventoryValue > 0) {
      lines.push({ accountCode: "1050", debit: input.inventoryValue, description: "Opening inventory at cost" });
    }
    if (input.receivablesTotal > 0) {
      lines.push({ accountCode: "1040", debit: input.receivablesTotal, description: "Opening customer receivables" });
    }
    if (input.vatInputTotal > 0) {
      lines.push({ accountCode: "1045", debit: input.vatInputTotal, description: "Opening VAT input" });
    }
    if (input.payablesTotal > 0) {
      lines.push({ accountCode: "2010", credit: input.payablesTotal, description: "Opening supplier payables" });
    }
    if (input.vatPayableTotal > 0) {
      lines.push({ accountCode: "2020", credit: input.vatPayableTotal, description: "Opening VAT payable" });
    }
    if (input.loansPayableTotal > 0) {
      lines.push({ accountCode: "2080", credit: input.loansPayableTotal, description: "Opening loans payable" });
    }
    if (input.ownerCapital > 0) {
      lines.push({ accountCode: "3010", credit: input.ownerCapital, description: "Owner capital at activation" });
    }
    const entryDate = input.entryDate ?? (await todayForBusiness(tx, businessId));
    const totalDebit = lines.reduce((sum, l) => sum + (l.debit ?? 0), 0);
    const totalCredit = lines.reduce((sum, l) => sum + (l.credit ?? 0), 0);
    const plug = Number((totalDebit - totalCredit).toFixed(2));

    // The retained-earnings plug balances whatever the owner entered — a
    // single cash account with no stated capital source is still a valid
    // opening (the plug becomes opening equity/accumulated losses). Reject
    // only an EMPTY activation: nothing entered at all, or a single account
    // that balances against nothing (no plug would be posted).
    if (lines.length === 0 || (lines.length === 1 && plug === 0)) {
      throw new BadRequestError(
        "Enter at least one opening balance (e.g. a cash account or owner capital) to activate the ledger.",
      );
    }
    if (plug > 0) {
      lines.push({ accountCode: "3030", credit: plug, description: "Retained earnings before Finance activation" });
    } else if (plug < 0) {
      lines.push({ accountCode: "3030", debit: -plug, description: "Accumulated losses before Finance activation" });
    }

    const { entry } = await postJournalEntry(tx, {
      businessId,
      entryDate,
      memo: input.memo ?? "Opening balances at Finance activation",
      sourceType: "opening",
      sourceId: businessId,
      cashFlowCategory: "none",
      status: "posted",
      lines,
      actorUserId,
    });

    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "finance.activated",
      entityType: "business",
      entityId: businessId,
      metadata: { entryNo: entry.entryNo, entryDate },
    });

    return { activated: true, activatedAt, openingEntry: entry };
  });
}

function accountTypeGlCode(type: "cash" | "bank" | "mfs"): string {
  return type === "cash" ? "1010" : type === "bank" ? "1020" : "1030";
}

async function requireAccountByCode(
  tx: Tx,
  businessId: number,
  code: string,
): Promise<AccountRow> {
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
  if (!account) {
    throw new NotFoundError(`System account ${code} is missing.`);
  }
  return account;
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

export async function listAccounts(
  businessId: number,
  opts: { includeArchived?: boolean; type?: string } = {},
) {
  const conditions = [eq(chartOfAccounts.businessId, businessId)];
  if (!opts.includeArchived) conditions.push(isNull(chartOfAccounts.archivedAt));
  if (opts.type) {
    conditions.push(
      eq(chartOfAccounts.type, opts.type as AccountRow["type"]),
    );
  }
  return db
    .select()
    .from(chartOfAccounts)
    .where(and(...conditions))
    .orderBy(asc(chartOfAccounts.code));
}

const NORMAL_BALANCE_BY_TYPE: Record<AccountRow["type"], "debit" | "credit"> = {
  asset: "debit",
  expense: "debit",
  liability: "credit",
  equity: "credit",
  revenue: "credit",
};

export async function createAccount(
  businessId: number,
  input: CreateAccountInput,
  actorUserId: number,
): Promise<AccountRow> {
  const [existing] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.businessId, businessId),
        eq(chartOfAccounts.code, input.code),
      ),
    )
    .limit(1);
  if (existing) {
    throw new ConflictError(`Account code ${input.code} already exists.`);
  }
  if (input.parentId != null) {
    await requireAccountInBusiness(businessId, input.parentId);
  }
  const [created] = await db
    .insert(chartOfAccounts)
    .values({
      businessId,
      code: input.code,
      name: input.name,
      type: input.type,
      normalBalance: NORMAL_BALANCE_BY_TYPE[input.type],
      isSystem: false,
      isCash: false,
      parentId: input.parentId ?? null,
      description: input.description ?? null,
    })
    .returning();
  if (!created) {
    throw new Error("Failed to create the account.");
  }
  await recordAudit({
    businessId,
    actorUserId,
    action: "finance.account.created",
    entityType: "chart_of_account",
    entityId: created.id,
    metadata: { code: created.code, name: created.name },
  });
  return created;
}

export async function updateAccount(
  businessId: number,
  accountId: number,
  input: UpdateAccountInput,
  actorUserId: number,
): Promise<AccountRow> {
  const account = await requireAccountInBusiness(businessId, accountId);
  if (input.parentId != null) {
    if (input.parentId === accountId) {
      throw new BadRequestError("An account cannot be its own parent.");
    }
    const parent = await requireAccountInBusiness(businessId, input.parentId);
    if (parent.type !== account.type) {
      throw new BadRequestError("Parent account must have the same type.");
    }
  }
  const [updated] = await db
    .update(chartOfAccounts)
    .set({
      name: input.name ?? account.name,
      description: input.description !== undefined ? input.description : account.description,
      parentId: input.parentId !== undefined ? input.parentId : account.parentId,
      updatedAt: new Date(),
    })
    .where(and(eq(chartOfAccounts.id, accountId), eq(chartOfAccounts.businessId, businessId)))
    .returning();
  if (!updated) {
    throw new Error("Failed to update the account.");
  }

  await recordAudit({
    businessId,
    actorUserId,
    action: "finance.account.updated",
    entityType: "chart_of_account",
    entityId: accountId,
    metadata: { code: account.code },
  });
  return updated;
}

/** System accounts can be archived (unused) but never deleted or re-coded. */
export async function archiveAccount(
  businessId: number,
  accountId: number,
  actorUserId: number,
): Promise<AccountRow> {
  const account = await requireAccountInBusiness(businessId, accountId);
  const [used] = await db
    .select({ value: count() })
    .from(journalEntryLines)
    .where(
      and(
        eq(journalEntryLines.accountId, accountId),
        eq(journalEntryLines.businessId, businessId),
      ),
    );
  if ((used?.value ?? 0) > 0) {
    throw new ConflictError(
      "This account has journal lines and cannot be archived.",
    );
  }
  const [updated] = await db
    .update(chartOfAccounts)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(chartOfAccounts.id, accountId), eq(chartOfAccounts.businessId, businessId)))
    .returning();
  if (!updated) {
    throw new Error("Failed to archive the account.");
  }
  await recordAudit({
    businessId,
    actorUserId,
    action: "finance.account.archived",
    entityType: "chart_of_account",
    entityId: accountId,
    metadata: { code: account.code },
  });
  return updated;
}

async function requireAccountInBusiness(
  businessId: number,
  accountId: number,
): Promise<AccountRow> {
  const [account] = await db
    .select()
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.id, accountId),
        eq(chartOfAccounts.businessId, businessId),
      ),
    )
    .limit(1);
  if (!account) throw new NotFoundError("Account not found.");
  return account;
}

// ---------------------------------------------------------------------------
// Payment accounts
// ---------------------------------------------------------------------------

export async function listPaymentAccounts(businessId: number) {
  return db
    .select()
    .from(paymentAccounts)
    .where(eq(paymentAccounts.businessId, businessId))
    .orderBy(asc(paymentAccounts.type), asc(paymentAccounts.name));
}

export async function createPaymentAccount(
  businessId: number,
  input: CreatePaymentAccountInput,
  actorUserId: number,
): Promise<PaymentAccountRow> {
  const gl = await requireAccountInBusiness(businessId, input.glAccountId);
  if (!gl.isCash) {
    throw new BadRequestError(
      "A payment account must map to a cash-equivalent GL account (isCash).",
    );
  }
  return db.transaction(async (tx) => {
    if (input.isDefault) {
      await clearDefaultPaymentAccount(tx, businessId, input.type);
    }
    const [created] = await tx
      .insert(paymentAccounts)
      .values({
        businessId,
        name: input.name,
        type: input.type,
        provider: input.provider ?? null,
        glAccountId: gl.id,
        isDefault: input.isDefault,
        notes: input.notes ?? null,
      })
      .returning();
    if (!created) {
      throw new Error("Failed to create the payment account.");
    }
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "finance.payment_account.created",
      entityType: "payment_account",
      entityId: created.id,
      metadata: { name: created.name, type: created.type },
    });
    return created;
  });
}

export async function updatePaymentAccount(
  businessId: number,
  paymentAccountId: number,
  input: UpdatePaymentAccountInput,
  actorUserId: number,
): Promise<PaymentAccountRow> {
  const [existing] = await db
    .select()
    .from(paymentAccounts)
    .where(
      and(
        eq(paymentAccounts.id, paymentAccountId),
        eq(paymentAccounts.businessId, businessId),
      ),
    )
    .limit(1);
  if (!existing) throw new NotFoundError("Payment account not found.");

  return db.transaction(async (tx) => {
    if (input.isDefault === true) {
      await clearDefaultPaymentAccount(tx, businessId, existing.type);
    }
    const [updated] = await tx
      .update(paymentAccounts)
      .set({
        name: input.name ?? existing.name,
        provider: input.provider !== undefined ? input.provider : existing.provider,
        isDefault: input.isDefault ?? existing.isDefault,
        isActive: input.isActive ?? existing.isActive,
        notes: input.notes !== undefined ? input.notes : existing.notes,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(paymentAccounts.id, paymentAccountId),
          eq(paymentAccounts.businessId, businessId),
        ),
      )
      .returning();
    if (!updated) {
      throw new Error("Failed to update the payment account.");
    }
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "finance.payment_account.updated",
      entityType: "payment_account",
      entityId: paymentAccountId,
      metadata: { name: updated.name },
    });
    return updated;
  });
}

async function clearDefaultPaymentAccount(
  tx: Tx,
  businessId: number,
  type: PaymentAccountRow["type"],
): Promise<void> {
  await tx
    .update(paymentAccounts)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(paymentAccounts.businessId, businessId),
        eq(paymentAccounts.type, type),
        eq(paymentAccounts.isDefault, true),
      ),
    );
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export async function listPeriods(businessId: number) {
  return db
    .select()
    .from(accountingPeriods)
    .where(eq(accountingPeriods.businessId, businessId))
    .orderBy(desc(accountingPeriods.periodStart));
}

export async function closePeriod(
  businessId: number,
  periodId: number,
  actorUserId: number,
) {
  const [period] = await db
    .select()
    .from(accountingPeriods)
    .where(
      and(
        eq(accountingPeriods.id, periodId),
        eq(accountingPeriods.businessId, businessId),
      ),
    )
    .limit(1);
  if (!period) throw new NotFoundError("Accounting period not found.");
  if (period.status === "closed") {
    throw new ConflictError("This period is already closed.");
  }
  const [updated] = await db
    .update(accountingPeriods)
    .set({ status: "closed", closedByUserId: actorUserId, closedAt: new Date(), updatedAt: new Date() })
    .where(eq(accountingPeriods.id, periodId))
    .returning();
  await recordAudit({
    businessId,
    actorUserId,
    action: "finance.period.closed",
    entityType: "accounting_period",
    entityId: periodId,
    metadata: { periodStart: period.periodStart },
  });
  return updated;
}

export async function reopenPeriod(
  businessId: number,
  periodId: number,
  actorUserId: number,
) {
  const [period] = await db
    .select()
    .from(accountingPeriods)
    .where(
      and(
        eq(accountingPeriods.id, periodId),
        eq(accountingPeriods.businessId, businessId),
      ),
    )
    .limit(1);
  if (!period) throw new NotFoundError("Accounting period not found.");
  if (period.status === "open") {
    throw new ConflictError("This period is already open.");
  }
  const [updated] = await db
    .update(accountingPeriods)
    .set({ status: "open", closedByUserId: null, closedAt: null, updatedAt: new Date() })
    .where(eq(accountingPeriods.id, periodId))
    .returning();
  await recordAudit({
    businessId,
    actorUserId,
    action: "finance.period.reopened",
    entityType: "accounting_period",
    entityId: periodId,
    metadata: { periodStart: period.periodStart },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------

const ENTRY_SORT_COLUMNS = {
  entry_date: journalEntries.entryDate,
  entry_no: journalEntries.entryNo,
  created_at: journalEntries.createdAt,
} as const;

export async function listEntries(businessId: number, query: ListEntriesQuery) {
  const conditions = [eq(journalEntries.businessId, businessId)];
  if (query.status) conditions.push(eq(journalEntries.status, query.status));
  if (query.source_type) {
    conditions.push(eq(journalEntries.sourceType, query.source_type));
  }
  if (query.date_from) conditions.push(gte(journalEntries.entryDate, query.date_from));
  if (query.date_to) conditions.push(lte(journalEntries.entryDate, query.date_to));
  if (query.search) {
    const like = `%${query.search}%`;
    conditions.push(
      or(
        ilike(journalEntries.entryNo, like),
        ilike(journalEntries.memo, like),
      )!,
    );
  }
  const where = and(...conditions);
  const sortColumn = ENTRY_SORT_COLUMNS[query.sort];
  const direction = query.sort_dir === "asc" ? asc : desc;

  const [totalRow] = await db
    .select({ value: count() })
    .from(journalEntries)
    .where(where);
  const rows = await db
    .select({
      id: journalEntries.id,
      entryNo: journalEntries.entryNo,
      entryDate: journalEntries.entryDate,
      memo: journalEntries.memo,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      cashFlowCategory: journalEntries.cashFlowCategory,
      status: journalEntries.status,
      reversalOfEntryId: journalEntries.reversalOfEntryId,
      createdAt: journalEntries.createdAt,
      totalDebit: sql<string>`(
        select coalesce(sum(l.debit), 0) from journal_entry_lines l
        where l.entry_id = ${journalEntries.id}
      )`,
    })
    .from(journalEntries)
    .where(where)
    .orderBy(direction(sortColumn))
    .limit(query.page_size)
    .offset((query.page - 1) * query.page_size);

  const total = totalRow?.value ?? 0;
  return {
    rows,
    meta: {
      page: query.page,
      pageSize: query.page_size,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.page_size)),
    },
  };
}

export async function getEntry(businessId: number, entryId: number) {
  const [entry] = await db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.id, entryId),
        eq(journalEntries.businessId, businessId),
      ),
    )
    .limit(1);
  if (!entry) throw new NotFoundError("Journal entry not found.");
  const lines = await db
    .select({
      id: journalEntryLines.id,
      accountId: journalEntryLines.accountId,
      accountCode: chartOfAccounts.code,
      accountName: chartOfAccounts.name,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      locationId: journalEntryLines.locationId,
      description: journalEntryLines.description,
    })
    .from(journalEntryLines)
    .innerJoin(
      chartOfAccounts,
      eq(chartOfAccounts.id, journalEntryLines.accountId),
    )
    .where(eq(journalEntryLines.entryId, entryId))
    .orderBy(asc(journalEntryLines.id));
  return { ...entry, lines };
}

/** Manual journal entry (draft by default, optionally posted immediately). */
export async function createJournalEntry(
  businessId: number,
  input: CreateJournalEntryInput,
  actorUserId: number,
) {
  return db.transaction(async (tx) =>
    postJournalEntry(tx, {
      businessId,
      ...(input.entryDate != null ? { entryDate: input.entryDate } : {}),
      memo: input.memo ?? null,
      sourceType: "manual",
      cashFlowCategory: "none",
      status: input.status,
      lines: input.lines.map((line) => ({
        ...(line.accountCode != null ? { accountCode: line.accountCode } : {}),
        ...(line.accountId != null ? { accountId: line.accountId } : {}),
        ...(line.debit != null ? { debit: line.debit } : {}),
        ...(line.credit != null ? { credit: line.credit } : {}),
        locationId: line.locationId ?? null,
        description: line.description ?? null,
      })),
      actorUserId,
    }),
  );
}

export async function updateDraftEntry(
  businessId: number,
  entryId: number,
  input: UpdateDraftEntryInput,
  actorUserId: number,
) {
  const [entry] = await db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.id, entryId),
        eq(journalEntries.businessId, businessId),
      ),
    )
    .limit(1);
  if (!entry) throw new NotFoundError("Journal entry not found.");
  if (entry.status !== "draft") {
    throw new ConflictError(
      "Only draft entries can be edited. Posted entries are immutable — reverse and repost instead.",
    );
  }
  if (entry.sourceType !== "manual" && entry.sourceType !== "adjustment") {
    throw new ConflictError("System-generated drafts cannot be edited here.");
  }

  return db.transaction(async (tx) => {
    await tx
      .delete(journalEntryLines)
      .where(eq(journalEntryLines.entryId, entryId));
    const [updated] = await tx
      .update(journalEntries)
      .set({
        entryDate: input.entryDate ?? entry.entryDate,
        memo: input.memo !== undefined ? input.memo : entry.memo,
        updatedAt: new Date(),
      })
      .where(eq(journalEntries.id, entryId))
      .returning();

    // Re-validate the replacement lines (accounts + balance), then insert.
    const resolved = await validateDraftLines(tx, businessId, entryId, input.lines);
    await tx.insert(journalEntryLines).values(resolved);
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "finance.journal.draft_updated",
      entityType: "journal_entry",
      entityId: entryId,
    });
    return updated;
  });
}

/** Draft lines: resolve accounts and enforce the same balance rules. */
async function validateDraftLines(
  tx: Tx,
  businessId: number,
  entryId: number,
  lines: UpdateDraftEntryInput["lines"],
) {
  let totalDebit = 0;
  let totalCredit = 0;
  const rows = [];
  for (const [index, line] of lines.entries()) {
    if (line.accountId != null && line.accountCode != null) {
      throw new BadRequestError(
        `Line ${index + 1}: specify either accountId or accountCode, not both.`,
      );
    }
    let accountId: number;
    if (line.accountId != null) {
      accountId = (await requireAccountInBusinessTx(tx, businessId, line.accountId)).id;
    } else {
      accountId = (await requireAccountByCode(tx, businessId, line.accountCode!)).id;
    }
    const hasDebit = (line.debit ?? 0) > 0;
    const hasCredit = (line.credit ?? 0) > 0;
    if (hasDebit === hasCredit) {
      throw new BadRequestError(
        `Line ${index + 1}: exactly one of debit/credit must be greater than zero.`,
      );
    }
    const debit = hasDebit ? Number((line.debit as number).toFixed(2)) : 0;
    const credit = hasCredit ? Number((line.credit as number).toFixed(2)) : 0;
    totalDebit += debit;
    totalCredit += credit;
    rows.push({
      entryId,
      businessId,
      accountId,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
      locationId: line.locationId ?? null,
      description: line.description ?? null,
    });
  }
  if (Math.round(totalDebit * 100) !== Math.round(totalCredit * 100)) {
    throw new ConflictError("Debits and credits must balance.");
  }
  return rows;
}

async function requireAccountInBusinessTx(
  tx: Tx,
  businessId: number,
  accountId: number,
): Promise<AccountRow> {
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
  if (!account) throw new NotFoundError(`Account ${accountId} not found.`);
  return account;
}

export async function postDraftEntry(
  businessId: number,
  entryId: number,
  actorUserId: number,
) {
  const [entry] = await db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.id, entryId),
        eq(journalEntries.businessId, businessId),
      ),
    )
    .limit(1);
  if (!entry) throw new NotFoundError("Journal entry not found.");
  if (entry.status !== "draft") {
    throw new ConflictError("Only draft entries can be posted.");
  }

  return db.transaction(async (tx) => {
    // Period control on the (possibly updated) entry date.
    await ensureOpenPeriodInTx(tx, businessId, entry.entryDate);
    const [posted] = await tx
      .update(journalEntries)
      .set({
        status: "posted",
        postedAt: new Date(),
        postedByUserId: actorUserId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(journalEntries.id, entryId),
          eq(journalEntries.businessId, businessId),
          eq(journalEntries.status, "draft"),
        ),
      )
      .returning();
    if (!posted) {
      throw new ConflictError("Journal entry was modified concurrently.");
    }
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "finance.journal.posted",
      entityType: "journal_entry",
      entityId: entryId,
      metadata: { entryNo: entry.entryNo, fromDraft: true },
    });
    return posted;
  });
}

export async function deleteDraftEntry(
  businessId: number,
  entryId: number,
  actorUserId: number,
) {
  const [entry] = await db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.id, entryId),
        eq(journalEntries.businessId, businessId),
      ),
    )
    .limit(1);
  if (!entry) throw new NotFoundError("Journal entry not found.");
  if (entry.status !== "draft") {
    throw new ConflictError(
      "Only draft entries can be deleted. Posted entries are reversed, never deleted.",
    );
  }
  await db.transaction(async (tx) => {
    await tx.delete(journalEntryLines).where(eq(journalEntryLines.entryId, entryId));
    await tx.delete(journalEntries).where(eq(journalEntries.id, entryId));
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "finance.journal.draft_deleted",
      entityType: "journal_entry",
      entityId: entryId,
      metadata: { entryNo: entry.entryNo },
    });
  });
  return { deleted: true };
}

export async function reversePostedEntry(
  businessId: number,
  entryId: number,
  input: ReverseEntryInput,
  actorUserId: number,
) {
  return db.transaction(async (tx) =>
    reverseEntryInLedger(tx, {
      businessId,
      entryId,
      reason: input.reason,
      ...(input.entryDate != null ? { entryDate: input.entryDate } : {}),
      actorUserId,
    }),
  );
}

// ---------------------------------------------------------------------------
// Balances & trial balance
// ---------------------------------------------------------------------------

export async function getBalances(
  businessId: number,
  opts: { fromDate?: string; toDate?: string },
) {
  return getAccountBalances(db, businessId, {
    ...(opts.fromDate != null ? { fromDate: opts.fromDate } : {}),
    ...(opts.toDate != null ? { toDate: opts.toDate } : {}),
  });
}

export interface TrialBalanceSection {
  type: string;
  accounts: { code: string; name: string; debit: string; credit: string }[];
  totalDebit: string;
  totalCredit: string;
}

/**
 * Classic trial balance: every account's balance on its normal side
 * (debit-normal accounts show their net as debit, credit-normal as credit).
 * A/L/E net-zero identity is surfaced via `balanced`.
 */
export async function getTrialBalance(businessId: number, toDate?: string) {
  const balances = await getAccountBalances(db, businessId, {
    ...(toDate != null ? { toDate } : {}),
  });
  const sections: TrialBalanceSection[] = [];
  let totalDebitPoisha = 0;
  let totalCreditPoisha = 0;
  for (const type of ["asset", "liability", "equity", "revenue", "expense"]) {
    const accounts = balances.filter((b) => b.type === type && b.balance !== "0.00");
    const section: TrialBalanceSection = { type, accounts: [], totalDebit: "0.00", totalCredit: "0.00" };
    let sectionDebit = 0;
    let sectionCredit = 0;
    for (const account of accounts) {
      const amountPoisha = Math.round(Number(account.balance) * 100);
      const debitNormal = account.normalBalance === "debit";
      // balance = Σdebit − Σcredit. Debit-normal accounts sit on the debit
      // side unless over-credited; credit-normal accounts sit on the credit
      // side unless over-debited.
      const isDebitSide = debitNormal
        ? amountPoisha >= 0
        : amountPoisha > 0;
      const abs = Math.abs(amountPoisha);
      if (isDebitSide) sectionDebit += abs;
      else sectionCredit += abs;
      section.accounts.push({
        code: account.code,
        name: account.name,
        debit: isDebitSide ? (abs / 100).toFixed(2) : "0.00",
        credit: isDebitSide ? "0.00" : (abs / 100).toFixed(2),
      });
    }
    totalDebitPoisha += sectionDebit;
    totalCreditPoisha += sectionCredit;
    section.totalDebit = (sectionDebit / 100).toFixed(2);
    section.totalCredit = (sectionCredit / 100).toFixed(2);
    if (accounts.length > 0) sections.push(section);
  }
  return {
    asOf: toDate ?? null,
    sections,
    totalDebit: (totalDebitPoisha / 100).toFixed(2),
    totalCredit: (totalCreditPoisha / 100).toFixed(2),
    balanced: totalDebitPoisha === totalCreditPoisha,
  };
}
