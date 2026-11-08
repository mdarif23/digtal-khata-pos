import { eq } from "drizzle-orm";
import { expenses } from "../../db/schema/expenses.js";
import { expenseCategories } from "../../db/schema/expenseCategories.js";
import type { Tx } from "../../services/audit.js";
import {
  isLedgerActivatedInTx,
  postJournalEntry,
  requireAccountById,
  resolveCashAccountForMethod,
} from "../../services/ledger.js";
import { roundMoney } from "../../utils/roundMoney.js";

/**
 * Landed cost → GL posting hook (Finance & Growth Stage 3).
 *
 * Scope: the INITIAL posting of a landed-cost document. Receive-flow deltas
 * and return reversals keep their traceable rows in landed_cost_adjustments
 * (which the P&L joins per the approved architecture §4) and are posted to
 * the GL in a later finance phase.
 *
 * Treatment for the initial post:
 *   DR 1050 Inventory      = allocated share landing on unsold units
 *   DR 5010 COGS           = allocated share of already-sold units
 *   CR  settlement accounts, weighted by each expense's capitalizable
 *       value: expense_payment → the linked expense's GL account
 *       (reclassification — the expense module already recorded the cash
 *       out), cash → default cash account, supplier_payable/unpaid → 2010.
 */

export interface LandedCostExpenseCredit {
  capitalizable: number;
  settlementType: string;
  /** expenses.id when settlementType === 'expense_payment'. */
  settlementReferenceId: number | null;
}

async function resolveExpenseAccountCode(
  tx: Tx,
  businessId: number,
  expenseId: number,
): Promise<string> {
  const [row] = await tx
    .select({ glAccountId: expenseCategories.glAccountId })
    .from(expenses)
    .leftJoin(
      expenseCategories,
      eq(expenseCategories.id, expenses.categoryId),
    )
    .where(eq(expenses.id, expenseId))
    .limit(1);
  if (row?.glAccountId != null) {
    const account = await requireAccountById(tx, businessId, row.glAccountId);
    return account.code;
  }
  return "5900";
}

export async function postLandedCostPostLedgerEntry(
  tx: Tx,
  params: {
    businessId: number;
    documentId: number;
    /** Allocated share landing on unsold units. */
    inventoryAmount: number;
    totalAllocated: number;
    expenses: LandedCostExpenseCredit[];
    locationId: number | null;
    actorUserId: number | null;
  },
): Promise<void> {
  const { businessId } = params;
  if (!(await isLedgerActivatedInTx(tx, businessId))) return;

  const totalAllocated = roundMoney(params.totalAllocated);
  const inventoryAmount = roundMoney(Math.min(params.inventoryAmount, totalAllocated));
  if (totalAllocated <= 0.005) return;

  const lines: Parameters<typeof postJournalEntry>[1]["lines"] = [];
  if (inventoryAmount > 0.005) {
    lines.push({
      accountCode: "1050",
      debit: inventoryAmount,
      locationId: params.locationId,
      description: "Landed cost capitalized to inventory",
    });
  }
  const cogsAmount = roundMoney(totalAllocated - inventoryAmount);
  if (cogsAmount > 0.005) {
    lines.push({
      accountCode: "5010",
      debit: cogsAmount,
      locationId: params.locationId,
      description: "Landed cost on already-sold units",
    });
  }

  // Weighted credit split across the document's expenses (last row absorbs
  // the rounding remainder so the entry balances exactly).
  const totalCapitalizable = roundMoney(
    params.expenses.reduce((sum, e) => sum + Math.max(0, e.capitalizable), 0),
  );
  let creditRemaining = totalAllocated;
  for (const [index, expense] of params.expenses.entries()) {
    const isLast = index === params.expenses.length - 1;
    const credit = isLast
      ? creditRemaining
      : totalCapitalizable > 0
        ? roundMoney(totalAllocated * (Math.max(0, expense.capitalizable) / totalCapitalizable))
        : 0;
    creditRemaining = roundMoney(creditRemaining - credit);
    if (credit <= 0.005) continue;

    if (expense.settlementType === "expense_payment" && expense.settlementReferenceId != null) {
      const expenseAccountCode = await resolveExpenseAccountCode(
        tx,
        businessId,
        expense.settlementReferenceId,
      );
      lines.push({
        accountCode: expenseAccountCode,
        credit,
        locationId: params.locationId,
        description: "Landed cost reclassified from expenses",
      });
    } else if (expense.settlementType === "cash") {
      const { account: cashAccount } = await resolveCashAccountForMethod(tx, businessId, "cash");
      lines.push({
        accountId: cashAccount.id,
        credit,
        locationId: params.locationId,
        description: "Landed cost paid in cash",
      });
    } else {
      lines.push({
        accountCode: "2010",
        credit,
        locationId: params.locationId,
        description: "Landed cost payable",
      });
    }
  }
  // A single settlement type is the common case; the weighted split keeps
  // mixed settlements balanced too. If rounding consumed everything, the
  // gateway's balance check surfaces it.

  await postJournalEntry(tx, {
    businessId,
    memo: `Landed cost posting ${params.documentId}`,
    sourceType: "landed_cost",
    sourceId: params.documentId,
    cashFlowCategory: "operating",
    lines,
    actorUserId: params.actorUserId,
  });
}

/**
 * Stock-count approval:
 *   net shrinkage  (decrease value > increase value): DR 5070 / CR 1050
 *   net gain       (increase value > decrease value): DR 1050 / CR 5070
 * Decreases consume batches FIFO at their landed cost; increases enter at
 * the variant's average landed cost — both computed by the approve flow.
 */
export async function postStockCountLedgerEntry(
  tx: Tx,
  params: {
    businessId: number;
    sessionId: number;
    shrinkageValue: number;
    increaseValue: number;
    locationId: number;
    actorUserId: number | null;
  },
): Promise<void> {
  const { businessId } = params;
  if (!(await isLedgerActivatedInTx(tx, businessId))) return;

  const net = roundMoney(params.shrinkageValue - params.increaseValue);
  if (Math.abs(net) <= 0.005) return;

  const lines: Parameters<typeof postJournalEntry>[1]["lines"] =
    net > 0
      ? [
          {
            accountCode: "5070",
            debit: net,
            locationId: params.locationId,
            description: "Inventory shrinkage (count variance)",
          },
          {
            accountCode: "1050",
            credit: net,
            locationId: params.locationId,
            description: "Inventory reduced by count variance",
          },
        ]
      : [
          {
            accountCode: "1050",
            debit: -net,
            locationId: params.locationId,
            description: "Inventory increased by count variance",
          },
          {
            accountCode: "5070",
            credit: -net,
            locationId: params.locationId,
            description: "Count variance gain",
          },
        ];

  await postJournalEntry(tx, {
    businessId,
    memo: `Stock count ${params.sessionId}`,
    sourceType: "stock_count",
    sourceId: params.sessionId,
    cashFlowCategory: "operating",
    lines,
    actorUserId: params.actorUserId,
  });
}
