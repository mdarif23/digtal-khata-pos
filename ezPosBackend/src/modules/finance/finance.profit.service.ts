import { and, desc, eq, lte, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  capitalTransactions,
  profitAllocationLines,
  profitAllocations,
} from "../../db/schema/ownerFinance.js";
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
} from "../../services/ledger.js";
import { poishaToMoneyString, toMoneyString } from "../../utils/money.js";
import { roundMoney } from "../../utils/roundMoney.js";
import type {
  CreateAllocationInput,
  RealizeAllocationInput,
} from "./finance.owner.schema.js";
import { recordCapitalTransactionInTx } from "./finance.owner.service.js";

/**
 * Profit calculation & allocation (Finance & Growth Stage 4 / Phase 2).
 *
 * All figures derive from POSTED ledger entries (the GL is the source of
 * truth once activated). Documented formulas (approved architecture §7.5):
 *
 *   netRevenue      = −bal(4010 Sales) − bal(4020 Returns)
 *                     − bal(4030 Delivery) − bal(4040 Other Income)
 *                     (credit-normal balances are negative)
 *   cogs            = bal(5010)
 *   grossProfit     = netRevenue − cogs
 *   operatingExpenses = Σ bal(5xxx) − cogs − interest   (incl. depreciation)
 *   operatingProfit = grossProfit − operatingExpenses
 *   netProfit       = operatingProfit − bal(5090 Loan Interest)
 *
 * An ALLOCATION is an internal designation — it posts no journal entry and
 * moves no cash. Realizing an owner_distribution line records an actual
 * capital transaction (which posts DR 3020 / CR cash).
 */

export interface ProfitFigures {
  from: string;
  to: string;
  netRevenue: string;
  cogs: string;
  grossProfit: string;
  operatingExpenses: string;
  operatingProfit: string;
  interest: string;
  netProfit: string;
  availableCash: string;
  breakdown: { code: string; name: string; balance: string }[];
}

function poisha(balance: string | undefined): number {
  return Math.round(Number(balance ?? 0) * 100);
}

/** Profit & loss figures for a date range, from posted ledger entries. */
export async function calculateProfit(
  businessId: number,
  from: string,
  to: string,
): Promise<ProfitFigures> {
  const [periodBalances, allTimeBalances] = await Promise.all([
    getAccountBalances(db, businessId, { fromDate: from, toDate: to }),
    getAccountBalances(db, businessId, {}),
  ]);

  const byCode = new Map(periodBalances.map((b) => [b.code, b]));
  const balanceOf = (code: string) => poisha(byCode.get(code)?.balance);

  const revenueSales = -balanceOf("4010");
  const salesReturns = balanceOf("4020");
  const deliveryIncome = -balanceOf("4030");
  const otherIncome = -balanceOf("4040");
  const netRevenuePoisha =
    revenueSales + deliveryIncome + otherIncome - salesReturns;

  const cogsPoisha = balanceOf("5010");
  const grossProfitPoisha = netRevenuePoisha - cogsPoisha;

  const interestPoisha = balanceOf("5090");
  const totalExpensesPoisha = periodBalances
    .filter((b) => b.type === "expense")
    .reduce((sum, b) => sum + poisha(b.balance), 0);
  const operatingExpensesPoisha =
    totalExpensesPoisha - cogsPoisha - interestPoisha;

  const operatingProfitPoisha = grossProfitPoisha - operatingExpensesPoisha;
  const netProfitPoisha = operatingProfitPoisha - interestPoisha;

  // Cash on hand = the seeded cash-equivalent system accounts (users cannot
  // create additional cash accounts — createAccount hardcodes isCash=false).
  const availableCashPoisha = allTimeBalances
    .filter((b) => b.code === "1010" || b.code === "1020" || b.code === "1030")
    .reduce((sum, b) => sum + poisha(b.balance), 0);

  return {
    from,
    to,
    netRevenue: poishaToMoneyString(netRevenuePoisha),
    cogs: poishaToMoneyString(cogsPoisha),
    grossProfit: poishaToMoneyString(grossProfitPoisha),
    operatingExpenses: poishaToMoneyString(operatingExpensesPoisha),
    operatingProfit: poishaToMoneyString(operatingProfitPoisha),
    interest: poishaToMoneyString(interestPoisha),
    netProfit: poishaToMoneyString(netProfitPoisha),
    availableCash: poishaToMoneyString(availableCashPoisha),
    breakdown: periodBalances
      .filter((b) => b.type === "revenue" || b.type === "expense")
      .map((b) => ({
        code: b.code,
        name: b.name,
        balance: b.balance,
      })),
  };
}

// ---------------------------------------------------------------------------
// Allocations
// ---------------------------------------------------------------------------

export async function listAllocations(businessId: number) {
  const allocations = await db
    .select()
    .from(profitAllocations)
    .where(eq(profitAllocations.businessId, businessId))
    .orderBy(desc(profitAllocations.periodStart), desc(profitAllocations.id));
  if (allocations.length === 0) return [];

  const lines = await db
    .select()
    .from(profitAllocationLines)
    .where(eq(profitAllocationLines.businessId, businessId));
  const linesByAllocation = new Map<number, typeof lines>();
  for (const line of lines) {
    const list = linesByAllocation.get(line.allocationId) ?? [];
    list.push(line);
    linesByAllocation.set(line.allocationId, list);
  }
  return allocations.map((allocation) => ({
    ...allocation,
    lines: linesByAllocation.get(allocation.id) ?? [],
  }));
}

async function requireAllocationInBusiness(
  businessId: number,
  allocationId: number,
) {
  const [allocation] = await db
    .select()
    .from(profitAllocations)
    .where(
      and(
        eq(profitAllocations.id, allocationId),
        eq(profitAllocations.businessId, businessId),
      ),
    )
    .limit(1);
  if (!allocation) throw new NotFoundError("Profit allocation not found.");
  return allocation;
}

/**
 * Confirm an allocation of distributable profit. Server-authoritative:
 * the distributable figure is recomputed from the GL, percent lines are
 * resolved server-side, and the total may not exceed the distributable
 * profit. Overlapping periods are rejected so no profit is allocated twice.
 */
export async function createAllocation(
  businessId: number,
  input: CreateAllocationInput,
  actorUserId: number,
) {
  if (!(await isLedgerActivatedInTx(db, businessId))) {
    throw new ConflictError(
      "The Finance ledger is not activated for this business.",
    );
  }

  // Overlap guard: a confirmed allocation for any intersecting period means
  // that profit is already designated.
  const existing = await db
    .select({
      id: profitAllocations.id,
      periodStart: profitAllocations.periodStart,
      periodEnd: profitAllocations.periodEnd,
    })
    .from(profitAllocations)
    .where(
      and(
        eq(profitAllocations.businessId, businessId),
        eq(profitAllocations.status, "confirmed"),
        lte(profitAllocations.periodStart, input.periodEnd),
        sql`${profitAllocations.periodEnd} >= ${input.periodStart}`,
      ),
    );
  if (existing.length > 0) {
    throw new ConflictError(
      "One or more confirmed allocations already cover this period. Reverse the existing allocation first.",
    );
  }

  const figures = await calculateProfit(
    businessId,
    input.periodStart,
    input.periodEnd,
  );
  const distributablePoisha = Math.round(Number(figures.netProfit) * 100);
  if (distributablePoisha <= 0) {
    throw new BadRequestError(
      `There is no distributable profit for this period (net profit ${figures.netProfit}).`,
    );
  }

  let totalPoisha = 0;
  const resolvedLines = input.lines.map((line) => {
    const amountPoisha =
      line.basisType === "percent"
        ? Math.round((distributablePoisha * Number(line.basisValue)) / 100)
        : Math.round(Number(line.amount) * 100);
    totalPoisha += amountPoisha;
    return {
      category: line.category,
      basisType: line.basisType,
      basisValue:
        line.basisType === "percent" ? Number(line.basisValue).toFixed(4) : null,
      amount: poishaToMoneyString(amountPoisha),
    };
  });
  if (totalPoisha > distributablePoisha) {
    throw new ConflictError(
      `Allocations total ${poishaToMoneyString(totalPoisha)} but only ${poishaToMoneyString(distributablePoisha)} of profit is distributable for this period.`,
    );
  }
  if (totalPoisha <= 0) {
    throw new BadRequestError("An allocation needs at least one positive line.");
  }

  return db.transaction(async (tx) => {
    const [allocation] = await tx
      .insert(profitAllocations)
      .values({
        businessId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        periodLabel: input.periodLabel ?? null,
        basisMetrics: {
          from: figures.from,
          to: figures.to,
          netRevenue: figures.netRevenue,
          cogs: figures.cogs,
          grossProfit: figures.grossProfit,
          operatingProfit: figures.operatingProfit,
          netProfit: figures.netProfit,
          availableCash: figures.availableCash,
          computedAt: new Date().toISOString(),
        },
        totalDistributable: poishaToMoneyString(distributablePoisha),
        totalAllocated: poishaToMoneyString(totalPoisha),
        createdByUserId: actorUserId,
      })
      .returning();
    if (!allocation) throw new Error("Failed to create the allocation.");

    const lines = await tx
      .insert(profitAllocationLines)
      .values(
        resolvedLines.map((line) => ({
          allocationId: allocation.id,
          businessId,
          category: line.category,
          basisType: line.basisType,
          basisValue: line.basisValue,
          amount: line.amount,
        })),
      )
      .returning();

    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "finance.profit.allocated",
      entityType: "profit_allocation",
      entityId: allocation.id,
      metadata: {
        period: `${input.periodStart}..${input.periodEnd}`,
        totalAllocated: allocation.totalAllocated,
        distributable: allocation.totalDistributable,
      },
    });
    return { ...allocation, lines };
  });
}

export async function reverseAllocation(
  businessId: number,
  allocationId: number,
  reason: string,
  actorUserId: number,
) {
  const allocation = await requireAllocationInBusiness(businessId, allocationId);
  if (allocation.status !== "confirmed") {
    throw new ConflictError("This allocation is already reversed.");
  }
  const [realized] = await db
    .select({
      value: sql<string>`coalesce(sum(${profitAllocationLines.realizedAmount}), 0)`,
    })
    .from(profitAllocationLines)
    .where(eq(profitAllocationLines.allocationId, allocationId));
  if (Number(realized?.value ?? 0) > 0.005) {
    throw new ConflictError(
      "This allocation has realized payments and cannot be reversed.",
    );
  }
  const [updated] = await db
    .update(profitAllocations)
    .set({ status: "reversed", reversalReason: reason, updatedAt: new Date() })
    .where(eq(profitAllocations.id, allocationId))
    .returning();
  await recordAudit({
    businessId,
    actorUserId,
    action: "finance.profit.allocation_reversed",
    entityType: "profit_allocation",
    entityId: allocationId,
    metadata: { reason },
  });
  return updated;
}

/**
 * Realize an owner-distribution share: records the ACTUAL payment as a
 * capital transaction (which posts DR 3020 / CR cash) and accumulates the
 * realized amount on the line. Reserve/reinvestment designations are not
 * realized here — they become real when the money is actually spent.
 */
export async function realizeAllocationLine(
  businessId: number,
  lineId: number,
  input: RealizeAllocationInput,
  actorUserId: number | null,
) {
  const [line] = await db
    .select({
      line: profitAllocationLines,
      allocation: profitAllocations,
    })
    .from(profitAllocationLines)
    .innerJoin(
      profitAllocations,
      eq(profitAllocations.id, profitAllocationLines.allocationId),
    )
    .where(
      and(
        eq(profitAllocationLines.id, lineId),
        eq(profitAllocationLines.businessId, businessId),
      ),
    )
    .limit(1);
  if (!line) throw new NotFoundError("Allocation line not found.");
  if (line.allocation.status !== "confirmed") {
    throw new ConflictError("This allocation is reversed.");
  }
  if (line.line.category !== "owner_distribution") {
    throw new BadRequestError(
      "Only owner-distribution shares are realized as payments. Reserve and reinvestment designations materialize through the transactions that spend them.",
    );
  }

  const amountPoisha = Math.round(Number(line.line.amount) * 100);
  const realizedPoisha = Math.round(Number(line.line.realizedAmount) * 100);
  const remainingPoisha = amountPoisha - realizedPoisha;
  if (remainingPoisha <= 0) {
    throw new ConflictError("This share is already fully realized.");
  }
  const requestedPoisha =
    input.amount != null ? Math.round(input.amount * 100) : remainingPoisha;
  if (requestedPoisha > remainingPoisha) {
    throw new ConflictError(
      `Realizing ${poishaToMoneyString(requestedPoisha)} exceeds the unrealized remainder of ${poishaToMoneyString(remainingPoisha)}.`,
    );
  }

  return db.transaction(async (tx) => {
    const { transaction } = await recordCapitalTransactionInTx(tx, businessId, {
      ownerProfileId: input.ownerProfileId,
      type: "distribution",
      amount: requestedPoisha / 100,
      txnDate: input.txnDate,
      paymentAccountId: input.paymentAccountId ?? null,
      method: input.method ?? "cash",
      reference: input.reference ?? null,
      description: `Profit distribution — allocation ${line.allocation.id} (${line.allocation.periodStart}..${line.allocation.periodEnd})`,
      clientUuid: null,
      attachmentUrl: null,
    }, actorUserId);

    const [updatedLine] = await tx
      .update(profitAllocationLines)
      .set({
        realizedAmount: poishaToMoneyString(realizedPoisha + requestedPoisha),
        realizedAt: new Date(),
        realizedReference: input.reference ?? transaction.reference,
        realizedCapitalTransactionId: transaction.id,
      })
      .where(eq(profitAllocationLines.id, lineId))
      .returning();

    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "finance.profit.realized",
      entityType: "profit_allocation_line",
      entityId: lineId,
      metadata: {
        capitalTransactionId: transaction.id,
        amount: poishaToMoneyString(requestedPoisha),
      },
    });
    return { line: updatedLine, transaction };
  });
}

/** GL cross-check helpers for the overview (Stage 6 will consume these). */
export async function getEquityPositions(businessId: number) {
  const balances = await getAccountBalances(db, businessId, {});
  const byCode = new Map(balances.map((b) => [b.code, b]));
  return {
    ownerContributions: toMoneyString(-poisha(byCode.get("3010")?.balance)),
    ownerDrawings: toMoneyString(poisha(byCode.get("3020")?.balance)),
    retainedEarnings: toMoneyString(-poisha(byCode.get("3030")?.balance)),
  };
}
