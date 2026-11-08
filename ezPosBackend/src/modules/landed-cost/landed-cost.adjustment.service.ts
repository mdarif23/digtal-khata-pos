import { and, eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  landedCostExpenses,
  landedCosts,
} from "../../db/schema/landedCosts.js";
import { BadRequestError, NotFoundError } from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";
import {
  applyReceiveDeltaInTx,
  lockDocumentForPurchaseInTx,
} from "./landed-cost.lifecycle.js";
import type { AdjustExpenseInput } from "./landed-cost.adjustment.schema.js";

// Takes the caller's server-verified businessId (from requireBusinessContext).

/**
 * Estimated → actual expense adjustment (Phase 7). The expense's amount
 * moves to the actual invoice figure; the difference flows through the
 * SAME cumulative-target delta the receive flow uses — allocated to
 * received batches (inventory portion) and to COGS for already-sold
 * units — with the adjustment, postings and audit rows written in the
 * same transaction.
 *
 * The PRE-adjustment amount is the estimate; it is preserved in the
 * landed_cost_adjustments history (previousAllocatedAmount/newAmount +
 * reason) — nothing is overwritten without a trail.
 *
 * Payable and supplier invoice totals are untouched: this reallocates
 * landed cost between inventory and COGS, it does not change what the
 * supplier is owed.
 */
export async function adjustLandedCostExpense(
  businessId: number,
  documentId: number,
  actorUserId: number,
  input: AdjustExpenseInput,
) {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(landedCosts)
      .where(
        and(
          eq(landedCosts.id, documentId),
          eq(landedCosts.businessId, businessId),
        ),
      )
      .for("update")
      .limit(1);

    if (!doc) {
      throw new NotFoundError("Landed-cost document not found.");
    }
    if (doc.status !== "posted" && doc.status !== "adjusted") {
      throw new BadRequestError(
        "Only posted landed-cost documents can be adjusted — edit the expenses of a draft instead.",
      );
    }

    // Lock-order anchor (see lockDocumentForPurchaseInTx).
    await lockDocumentForPurchaseInTx(tx, businessId, doc.purchaseId);

    const [expense] = await tx
      .select()
      .from(landedCostExpenses)
      .where(
        and(
          eq(landedCostExpenses.id, input.expenseId),
          eq(landedCostExpenses.landedCostId, documentId),
          eq(landedCostExpenses.businessId, businessId),
        ),
      )
      .for("update")
      .limit(1);

    if (!expense) {
      throw new NotFoundError("Expense not found on this document.");
    }

    const previousAmount = roundMoney(Number(expense.amount));
    const newAmount = roundMoney(input.newAmount);
    if (newAmount === previousAmount) {
      throw new BadRequestError(
        `The adjusted amount equals the current amount (${previousAmount.toFixed(2)}) — nothing to adjust.`,
      );
    }
    const delta = roundMoney(newAmount - previousAmount);

    // The expense's new amount is visible to the delta recomputation
    // through this same transaction.
    await tx
      .update(landedCostExpenses)
      .set({ amount: newAmount })
      .where(eq(landedCostExpenses.id, input.expenseId));

    // The SAME cumulative-target delta the receive flow uses — it reads
    // the updated expense through this transaction and posts only the
    // difference (inventory vs COGS split included).
    const landedCost = await applyReceiveDeltaInTx(
      tx,
      businessId,
      doc.purchaseId,
      actorUserId,
      {
        adjustmentType: "manual",
        referenceType: "landed_cost_expense",
        referenceId: input.expenseId,
        reason:
          input.reason?.trim() ||
          `Expense adjusted: ${previousAmount.toFixed(2)} → ${newAmount.toFixed(2)}`,
      },
    );

    // The delta function returns the INCREMENT; read the cumulative total
    // from the document for the response.
    const [updatedDoc] = await tx
      .select({ totalAllocated: landedCosts.totalAllocatedAmount })
      .from(landedCosts)
      .where(eq(landedCosts.id, documentId))
      .limit(1);

    return {
      success: true,
      message: "Expense adjusted.",
      data: {
        documentId,
        expenseId: input.expenseId,
        previousAmount,
        newAmount,
        delta,
        totalAllocated: roundMoney(Number(updatedDoc?.totalAllocated ?? 0)),
        landedCost,
      },
    };
  });
}
