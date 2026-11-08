import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  assetDepreciationPostings,
  businessAssets,
  businessLoans,
  loanRepayments,
} from "../../db/schema/financeAssetsLoans.js";
import { journalEntries } from "../../db/schema/journalEntries.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { recordAuditInTx, recordAudit } from "../../services/audit.js";
import type { Tx } from "../../services/audit.js";
import {
  getAccountBalances,
  isLedgerActivatedInTx,
  postJournalEntry,
  resolveCashAccountForMethod,
  todayForBusiness,
} from "../../services/ledger.js";
import { poishaToMoneyString, toMoneyString } from "../../utils/money.js";
import { roundMoney } from "../../utils/roundMoney.js";

/**
 * Loans, business assets & depreciation, and the balance sheet
 * (Finance & Growth Stage 7 / Phase 7).
 *
 * GL treatment (documented, architecture §7.5):
 *   loan disbursed  DR cash / CR 2080 Loans Payable        (financing)
 *   repayment       DR 2080 principal + DR 5090 interest / CR cash
 *   asset acquired  DR 1080/1081/1082 / CR cash-or-2010     (investing)
 *   depreciation    DR 5100 / CR 1090 (straight-line, monthly, idempotent)
 *
 * BALANCE SHEET FORMULAS (asOf = point-in-time through the given date):
 *   assets  = Σ debit-normal asset balances, net fixed assets =
 *             (1080+1081+1082) − (−bal 1090 accumulated, credit-normal)
 *   liabilities = −(credit-normal 2xxx balances)
 *   equity  = contributions(−3010) − drawings(3020) + retained(−3030)
 *             + current earnings (Σ revenue − Σ expense, still open on the
 *             books until a year-end close)
 *   balanced flag: A === L + E (exact, poisha).
 */

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

export interface CreateLoanInput {
  lenderType: "bank" | "mfs" | "owner" | "other";
  lenderName: string;
  principal: number;
  interestRate?: number | null;
  loanDate?: string;
  dueDate?: string | null;
  installmentCount?: number | null;
  installmentAmount?: number | null;
  method?: string | null;
  paymentAccountId?: number | null;
  notes?: string | null;
}

export async function createLoan(
  businessId: number,
  input: CreateLoanInput,
  actorUserId: number | null,
) {
  return db.transaction(async (tx) => {
    if (!(await isLedgerActivatedInTx(tx, businessId))) {
      throw new ConflictError(
        "The Finance ledger is not activated for this business.",
      );
    }
    const principal = roundMoney(input.principal);
    const loanDate = input.loanDate ?? (await todayForBusiness(tx, businessId));
    const { account, paymentAccountId } = await resolveCashAccountForMethod(
      tx,
      businessId,
      input.method ?? "cash",
      { paymentAccountId: input.paymentAccountId ?? null },
    );
    if (
      input.paymentAccountId != null &&
      paymentAccountId !== input.paymentAccountId
    ) {
      throw new NotFoundError("Payment account not found for this business.");
    }

    // Disbursement: DR cash / CR 2080 (financing).
    const { entry } = await postJournalEntry(tx, {
      businessId,
      entryDate: loanDate,
      memo: `Loan received — ${input.lenderName}`,
      sourceType: "loan",
      cashFlowCategory: "financing",
      lines: [
        { accountId: account.id, debit: principal, description: "Loan received" },
        { accountCode: "2080", credit: principal, description: "Loans payable" },
      ],
      actorUserId,
    });

    const [created] = await tx
      .insert(businessLoans)
      .values({
        businessId,
        lenderType: input.lenderType,
        lenderName: input.lenderName,
        principal: toMoneyString(principal),
        interestRate:
          input.interestRate != null ? input.interestRate.toFixed(3) : null,
        loanDate,
        dueDate: input.dueDate ?? null,
        installmentCount: input.installmentCount ?? null,
        installmentAmount:
          input.installmentAmount != null
            ? toMoneyString(input.installmentAmount)
            : null,
        notes: input.notes ?? null,
        journalEntryId: entry.id,
        createdByUserId: actorUserId,
      })
      .returning();
    if (!created) throw new Error("Failed to create the loan.");

    await tx
      .update(journalEntries)
      .set({ sourceId: created.id })
      .where(eq(journalEntries.id, entry.id));

    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "finance.loan.created",
      entityType: "business_loan",
      entityId: created.id,
      metadata: { lender: created.lenderName, principal: created.principal },
    });
    return created;
  });
}

export async function listLoans(businessId: number) {
  const loans = await db
    .select()
    .from(businessLoans)
    .where(eq(businessLoans.businessId, businessId))
    .orderBy(desc(businessLoans.loanDate));
  if (loans.length === 0) return [];

  const repaid = await db
    .select({
      loanId: loanRepayments.loanId,
      principal: sql<string>`coalesce(sum(${loanRepayments.principalAmount}), 0)`,
      interest: sql<string>`coalesce(sum(${loanRepayments.interestAmount}), 0)`,
    })
    .from(loanRepayments)
    .where(eq(loanRepayments.businessId, businessId))
    .groupBy(loanRepayments.loanId);
  const byLoan = new Map(repaid.map((r) => [r.loanId, r]));

  return loans.map((loan) => {
    const totals = byLoan.get(loan.id);
    const principalRepaid = Number(totals?.principal ?? 0);
    const outstanding = roundMoney(Number(loan.principal) - principalRepaid);
    return {
      ...loan,
      principalRepaid: toMoneyString(principalRepaid),
      interestPaid: toMoneyString(Number(totals?.interest ?? 0)),
      outstanding: toMoneyString(outstanding),
    };
  });
}

async function requireLoanInBusinessTx(tx: Tx, businessId: number, loanId: number) {
  const [loan] = await tx
    .select()
    .from(businessLoans)
    .where(
      and(eq(businessLoans.id, loanId), eq(businessLoans.businessId, businessId)),
    )
    .for("update")
    .limit(1);
  if (!loan) throw new NotFoundError("Loan not found.");
  return loan;
}

export interface RecordRepaymentInput {
  principalAmount: number;
  interestAmount?: number;
  paymentDate?: string;
  method?: string | null;
  paymentAccountId?: number | null;
  reference?: string | null;
  clientUuid?: string | null;
}

/**
 * Record a loan repayment: principal reduces 2080, interest is an expense
 * (5090) — the two are NEVER conflated. A loan whose principal is fully
 * repaid closes automatically.
 */
export async function recordLoanRepayment(
  businessId: number,
  loanId: number,
  input: RecordRepaymentInput,
  actorUserId: number | null,
) {
  return db.transaction(async (tx) => {
    const loan = await requireLoanInBusinessTx(tx, businessId, loanId);
    if (loan.status !== "active") {
      throw new ConflictError(
        `This loan is ${loan.status} — repayments are closed.`,
      );
    }
    if (input.clientUuid) {
      const [existing] = await tx
        .select()
        .from(loanRepayments)
        .where(
          and(
            eq(loanRepayments.clientUuid, input.clientUuid),
            eq(loanRepayments.businessId, businessId),
          ),
        )
        .limit(1);
      if (existing) {
        return { repayment: existing, duplicate: true as const };
      }
    }

    const [repaidTotals] = await tx
      .select({
        principal: sql<string>`coalesce(sum(${loanRepayments.principalAmount}), 0)`,
      })
      .from(loanRepayments)
      .where(
        and(
          eq(loanRepayments.loanId, loanId),
          eq(loanRepayments.businessId, businessId),
        ),
      );
    const outstanding = roundMoney(
      Number(loan.principal) - Number(repaidTotals?.principal ?? 0),
    );
    const principal = roundMoney(input.principalAmount);
    if (principal > outstanding) {
      throw new BadRequestError(
        `Principal repayment of ${principal.toFixed(2)} exceeds the outstanding ${outstanding.toFixed(2)}.`,
      );
    }
    const interest = roundMoney(input.interestAmount ?? 0);
    const total = roundMoney(principal + interest);

    const paymentDate = input.paymentDate ?? (await todayForBusiness(tx, businessId));
    const { account, paymentAccountId } = await resolveCashAccountForMethod(
      tx,
      businessId,
      input.method ?? "cash",
      { paymentAccountId: input.paymentAccountId ?? null },
    );

    const lines: Parameters<typeof postJournalEntry>[1]["lines"] = [
      { accountCode: "2080", debit: principal, description: "Loan principal repaid" },
    ];
    if (interest > 0.005) {
      lines.push({
        accountCode: "5090",
        debit: interest,
        description: "Loan interest expense",
      });
    }
    lines.push({
      accountId: account.id,
      credit: total,
      description: "Loan repayment",
    });

    const { entry } = await postJournalEntry(tx, {
      businessId,
      entryDate: paymentDate,
      memo: `Loan repayment — ${loan.lenderName}`,
      sourceType: "loan_repayment",
      cashFlowCategory: "financing",
      lines,
      actorUserId,
    });

    const [created] = await tx
      .insert(loanRepayments)
      .values({
        businessId,
        loanId,
        paymentDate,
        principalAmount: toMoneyString(principal),
        interestAmount: toMoneyString(interest),
        totalAmount: toMoneyString(total),
        method: input.method ?? null,
        paymentAccountId,
        reference: input.reference ?? null,
        journalEntryId: entry.id,
        clientUuid: input.clientUuid ?? null,
        createdByUserId: actorUserId,
      })
      .returning();
    if (!created) throw new Error("Failed to record the repayment.");

    await tx
      .update(journalEntries)
      .set({ sourceId: created.id })
      .where(eq(journalEntries.id, entry.id));

    // Auto-close when the principal is fully repaid.
    const newOutstanding = roundMoney(outstanding - principal);
    if (newOutstanding <= 0.005) {
      await tx
        .update(businessLoans)
        .set({ status: "closed", updatedAt: new Date() })
        .where(eq(businessLoans.id, loanId));
    }

    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "finance.loan.repayment",
      entityType: "loan_repayment",
      entityId: created.id,
      metadata: {
        loanId,
        principal: created.principalAmount,
        interest: created.interestAmount,
      },
    });
    return { repayment: created, duplicate: false as const };
  });
}

export async function listLoanRepayments(businessId: number, loanId: number) {
  return db
    .select()
    .from(loanRepayments)
    .where(
      and(
        eq(loanRepayments.businessId, businessId),
        eq(loanRepayments.loanId, loanId),
      ),
    )
    .orderBy(desc(loanRepayments.paymentDate), desc(loanRepayments.id));
}

// ---------------------------------------------------------------------------
// Assets & depreciation
// ---------------------------------------------------------------------------

const ASSET_GL_BY_CATEGORY: Record<string, string> = {
  equipment: "1080",
  furniture: "1081",
  vehicle: "1082",
  other: "1080",
};

export interface CreateAssetInput {
  name: string;
  category: "equipment" | "furniture" | "vehicle" | "other";
  acquiredAt: string;
  cost: number;
  salvageValue?: number;
  usefulLifeMonths: number;
  /** Payment method; omit to accrue on 2010 Accounts Payable. */
  method?: string | null;
  paymentAccountId?: number | null;
  locationId?: number | null;
  notes?: string | null;
}

export async function createAsset(
  businessId: number,
  input: CreateAssetInput,
  actorUserId: number | null,
) {
  return db.transaction(async (tx) => {
    if (!(await isLedgerActivatedInTx(tx, businessId))) {
      throw new ConflictError(
        "The Finance ledger is not activated for this business.",
      );
    }
    const cost = roundMoney(input.cost);
    const salvage = roundMoney(input.salvageValue ?? 0);
    if (salvage >= cost) {
      throw new BadRequestError(
        "Salvage value must be below the acquisition cost.",
      );
    }

    const glCode = ASSET_GL_BY_CATEGORY[input.category] ?? "1080";
    let cashAccountId: number | null = null;
    if (input.method) {
      const { account, paymentAccountId } = await resolveCashAccountForMethod(
        tx,
        businessId,
        input.method,
        { paymentAccountId: input.paymentAccountId ?? null },
      );
      if (
        input.paymentAccountId != null &&
        paymentAccountId !== input.paymentAccountId
      ) {
        throw new NotFoundError("Payment account not found for this business.");
      }
      cashAccountId = account.id;
    }

    // Acquisition: DR asset GL / CR cash (paid) or 2010 (accrued). Investing.
    const lines: Parameters<typeof postJournalEntry>[1]["lines"] = [
      { accountCode: glCode, debit: cost, description: input.name },
    ];
    if (cashAccountId != null) {
      lines.push({
        accountId: cashAccountId,
        credit: cost,
        description: `Asset acquisition — ${input.name}`,
      });
    } else {
      lines.push({
        accountCode: "2010",
        credit: cost,
        description: "Asset acquisition on account",
      });
    }
    const { entry } = await postJournalEntry(tx, {
      businessId,
      entryDate: input.acquiredAt,
      memo: `Asset acquired — ${input.name}`,
      sourceType: "asset",
      cashFlowCategory: "investing",
      lines,
      actorUserId,
    });

    const [created] = await tx
      .insert(businessAssets)
      .values({
        businessId,
        name: input.name,
        category: input.category,
        acquiredAt: input.acquiredAt,
        cost: toMoneyString(cost),
        salvageValue: toMoneyString(salvage),
        usefulLifeMonths: input.usefulLifeMonths,
        locationId: input.locationId ?? null,
        notes: input.notes ?? null,
        journalEntryId: entry.id,
        createdByUserId: actorUserId,
      })
      .returning();
    if (!created) throw new Error("Failed to create the asset.");

    await tx
      .update(journalEntries)
      .set({ sourceId: created.id })
      .where(eq(journalEntries.id, entry.id));

    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "finance.asset.created",
      entityType: "business_asset",
      entityId: created.id,
      metadata: { name: created.name, cost: created.cost },
    });
    return created;
  });
}

export async function listAssets(businessId: number) {
  const assets = await db
    .select()
    .from(businessAssets)
    .where(eq(businessAssets.businessId, businessId))
    .orderBy(desc(businessAssets.acquiredAt));
  return assets.map((asset) => {
    const bookValue = roundMoney(
      Number(asset.cost) - Number(asset.accumulatedDepreciation),
    );
    return {
      ...asset,
      bookValue: toMoneyString(bookValue),
    };
  });
}

/**
 * Straight-line monthly depreciation for one asset:
 *   monthly = (cost − salvage) / usefulLifeMonths
 * clamped so accumulated depreciation never exceeds (cost − salvage).
 * Idempotent per (asset, periodMonth).
 */
export async function runDepreciation(
  businessId: number,
  periodMonth: string,
  actorUserId: number | null,
): Promise<{ posted: number; totalAmount: string }> {
  if (!/^\d{4}-\d{2}-01$/.test(periodMonth)) {
    throw new BadRequestError("periodMonth must be YYYY-MM-01.");
  }
  if (!(await isLedgerActivatedInTx(db, businessId))) {
    throw new ConflictError(
      "The Finance ledger is not activated for this business.",
    );
  }

  const assets = await db
    .select()
    .from(businessAssets)
    .where(
      and(
        eq(businessAssets.businessId, businessId),
        eq(businessAssets.status, "active"),
      ),
    );

  let posted = 0;
  let totalPoisha = 0;
  for (const asset of assets) {
    // Full-month convention: depreciate from the acquisition MONTH onward.
    if (asset.acquiredAt.slice(0, 7) > periodMonth.slice(0, 7)) continue;
    const [alreadyPosted] = await db
      .select({ id: assetDepreciationPostings.id })
      .from(assetDepreciationPostings)
      .where(
        and(
          eq(assetDepreciationPostings.assetId, asset.id),
          eq(assetDepreciationPostings.periodMonth, periodMonth),
        ),
      )
      .limit(1);
    if (alreadyPosted) continue;

    const depreciableBase = roundMoney(
      Number(asset.cost) - Number(asset.salvageValue),
    );
    const monthlyRaw = roundMoney(depreciableBase / asset.usefulLifeMonths);
    const accumulated = Number(asset.accumulatedDepreciation);
    const remaining = roundMoney(depreciableBase - accumulated);
    const amount = Math.min(monthlyRaw, remaining);
    if (amount <= 0.005) continue;

    await db.transaction(async (tx) => {
      const { entry } = await postJournalEntry(tx, {
        businessId,
        entryDate: periodMonth,
        memo: `Depreciation — ${asset.name} (${periodMonth.slice(0, 7)})`,
        sourceType: "asset_depreciation",
        cashFlowCategory: "none",
        lines: [
          {
            accountCode: "5100",
            debit: amount,
            description: `Depreciation — ${asset.name}`,
          },
          {
            accountCode: "1090",
            credit: amount,
            description: "Accumulated depreciation",
          },
        ],
        actorUserId,
      });

      const [posting] = await tx
        .insert(assetDepreciationPostings)
        .values({
          businessId,
          assetId: asset.id,
          periodMonth,
          amount: toMoneyString(amount),
          accumulatedAfter: toMoneyString(roundMoney(accumulated + amount)),
          journalEntryId: entry.id,
        })
        .returning();
      if (!posting) throw new Error("Failed to record the depreciation posting.");

      await tx
        .update(journalEntries)
        .set({ sourceId: posting.id })
        .where(eq(journalEntries.id, entry.id));

      await tx
        .update(businessAssets)
        .set({
          accumulatedDepreciation: toMoneyString(roundMoney(accumulated + amount)),
          updatedAt: new Date(),
        })
        .where(eq(businessAssets.id, asset.id));

      await recordAuditInTx(tx, {
        businessId,
        actorUserId,
        action: "finance.asset.depreciated",
        entityType: "asset_depreciation_posting",
        entityId: posting.id,
        metadata: { assetId: asset.id, amount: posting.amount },
      });
    });
    posted += 1;
    totalPoisha += Math.round(amount * 100);
  }

  return { posted, totalAmount: poishaToMoneyString(totalPoisha) };
}

/** Scheduler entry: depreciate the PREVIOUS month for every business. */
export async function runAssetDepreciationSweeps(): Promise<{ postings: number }> {
  const businesses = await db.execute(
    sql`select id from businesses where ledger_activated_at is not null`,
  );
  const prevMonth = new Date();
  prevMonth.setUTCDate(1);
  prevMonth.setUTCMonth(prevMonth.getUTCMonth() - 1);
  const periodMonth = prevMonth.toISOString().slice(0, 10);
  let postings = 0;
  for (const row of businesses.rows) {
    const businessId = Number((row as { id: number }).id);
    const result = await runDepreciation(businessId, periodMonth, null);
    postings += result.posted;
  }
  return { postings };
}

// ---------------------------------------------------------------------------
// Balance sheet & net worth
// ---------------------------------------------------------------------------

export interface BalanceSheetSectionLine {
  code: string;
  name: string;
  balance: string;
}

export interface BalanceSheet {
  asOf: string;
  assets: {
    lines: BalanceSheetSectionLine[];
    netFixedAssets: string;
    total: string;
  };
  liabilities: { lines: BalanceSheetSectionLine[]; total: string };
  equity: {
    lines: BalanceSheetSectionLine[];
    currentEarnings: string;
    total: string;
  };
  netWorth: string;
  balanced: boolean;
}

/**
 * Balance sheet as of a date, straight from the GL. `balanced` asserts
 * Assets = Liabilities + Equity exactly (poisha) — including the still-open
 * revenue/expense accounts as "current earnings" (they close into retained
 * earnings at a year-end close, which this system has not introduced).
 */
export async function getBalanceSheet(
  businessId: number,
  asOf?: string,
): Promise<BalanceSheet> {
  const balances = await getAccountBalances(
    db,
    businessId,
    asOf ? { toDate: asOf } : {},
  );
  const byCode = new Map(balances.map((b) => [b.code, b]));
  const p = (code: string) => Math.round(Number(byCode.get(code)?.balance ?? 0) * 100);
  const lineOf = (code: string, sign: 1 | -1): BalanceSheetSectionLine => {
    const account = byCode.get(code);
    return {
      code,
      name: account?.name ?? code,
      balance: poishaToMoneyString(sign * p(code)),
    };
  };

  // Assets: debit-normal (positive balances).
  const assetLines: BalanceSheetSectionLine[] = [
    lineOf("1010", 1),
    lineOf("1020", 1),
    lineOf("1030", 1),
    lineOf("1040", 1),
    lineOf("1045", 1),
    lineOf("1050", 1),
    lineOf("1060", 1),
    lineOf("1070", 1),
  ]
    .filter((l) => l.balance !== "0.00");
  const grossFixedPoisha = p("1080") + p("1081") + p("1082");
  const accumulatedPoisha = -p("1090"); // contra-asset: credit-normal (negative)
  const netFixedPoisha = grossFixedPoisha - accumulatedPoisha;
  if (netFixedPoisha !== 0) {
    assetLines.push({
      code: "1080-90",
      name: "Fixed Assets (net of accumulated depreciation)",
      balance: poishaToMoneyString(netFixedPoisha),
    });
  }
  const totalAssetsPoisha =
    assetLines.reduce((s, l) => s + Math.round(Number(l.balance) * 100), 0);

  // Liabilities: credit-normal (negative balances → negated).
  const liabilityCodes = ["2010", "2020", "2030", "2040", "2050", "2060", "2070", "2080"];
  const liabilityLines = liabilityCodes
    .map((code) => lineOf(code, -1))
    .filter((l) => l.balance !== "0.00");
  const totalLiabilitiesPoisha = liabilityLines.reduce(
    (s, l) => s + Math.round(Number(l.balance) * 100),
    0,
  );

  // Equity: contributions − drawings + retained + still-open earnings.
  const equityLines: BalanceSheetSectionLine[] = [
    lineOf("3010", -1),
    lineOf("3020", 1),
    lineOf("3030", -1),
  ].filter((l) => l.balance !== "0.00");
  const revenuePoisha = balances
    .filter((b) => b.type === "revenue")
    .reduce((s, b) => s - p(b.code), 0);
  const expensePoisha = balances
    .filter((b) => b.type === "expense")
    .reduce((s, b) => s + p(b.code), 0);
  const currentEarningsPoisha = revenuePoisha - expensePoisha;
  const totalEquityPoisha =
    equityLines.reduce((s, l) => s + Math.round(Number(l.balance) * 100), 0) +
    currentEarningsPoisha;

  return {
    asOf: asOf ?? "now",
    assets: {
      lines: assetLines,
      netFixedAssets: poishaToMoneyString(netFixedPoisha),
      total: poishaToMoneyString(totalAssetsPoisha),
    },
    liabilities: {
      lines: liabilityLines,
      total: poishaToMoneyString(totalLiabilitiesPoisha),
    },
    equity: {
      lines: equityLines,
      currentEarnings: poishaToMoneyString(currentEarningsPoisha),
      total: poishaToMoneyString(totalEquityPoisha),
    },
    netWorth: poishaToMoneyString(totalAssetsPoisha - totalLiabilitiesPoisha),
    balanced: totalAssetsPoisha === totalLiabilitiesPoisha + totalEquityPoisha,
  };
}
