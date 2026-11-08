import { eq } from "drizzle-orm";
import { expenses } from "../../db/schema/expenses.js";
import { expensePayments } from "../../db/schema/expensePayments.js";
import { expenseCategories } from "../../db/schema/expenseCategories.js";
import type { Tx } from "../../services/audit.js";
import {
  findPostedEntryBySource,
  isLedgerActivatedInTx,
  postJournalEntry,
  requireAccountById,
  resolveCashAccountForMethod,
  reverseEntry,
} from "../../services/ledger.js";
import { roundMoney } from "../../utils/roundMoney.js";

/**
 * Expenses → GL posting hooks (Finance & Growth Stage 3).
 *
 * Treatment:
 *   Expense (accrual at creation):
 *     DR  mapped expense account (category.gl_account_id, else 5900)
 *     CR  cash/bank/MFS account  = paid portion (initial payment)
 *     CR  2010 Accounts Payable  = unpaid portion
 *   Settlement payment:
 *     DR  2010 / CR cash account (payment_account_id stamped on the row)
 *   Voiding reverses the corresponding posted entry (posted entries are
 *   never edited or deleted).
 */

export interface ExpenseLedgerInput {
  id: number;
  amount: number;
  paidAmount: number;
  categoryId: number | null;
  locationId: number | null;
  title: string;
}

async function resolveExpenseAccount(
  tx: Tx,
  businessId: number,
  categoryId: number | null,
): Promise<string> {
  if (categoryId != null) {
    const [category] = await tx
      .select({ glAccountId: expenseCategories.glAccountId })
      .from(expenseCategories)
      .where(
        eq(expenseCategories.id, categoryId),
      )
      .limit(1);
    if (category?.glAccountId != null) {
      const account = await requireAccountById(tx, businessId, category.glAccountId);
      return account.code;
    }
  }
  return "5900";
}

/** Accrual entry at expense creation (initial payment included). */
export async function postExpenseLedgerEntry(
  tx: Tx,
  params: {
    businessId: number;
    expense: ExpenseLedgerInput;
    initialPayment: {
      paymentId: number;
      amount: number;
      method: string;
      registerSessionId: number | null;
    } | null;
    actorUserId: number | null;
  },
): Promise<void> {
  const { businessId, expense } = params;
  if (!(await isLedgerActivatedInTx(tx, businessId))) return;

  const amount = roundMoney(Number(expense.amount));
  const paid = Math.min(roundMoney(Number(expense.paidAmount)), amount);
  const lines: Parameters<typeof postJournalEntry>[1]["lines"] = [];

  const expenseAccountCode = await resolveExpenseAccount(
    tx,
    businessId,
    expense.categoryId,
  );
  lines.push({
    accountCode: expenseAccountCode,
    debit: amount,
    locationId: expense.locationId,
    description: expense.title,
  });

  if (paid > 0.005 && params.initialPayment) {
    const { account, paymentAccountId } = await resolveCashAccountForMethod(
      tx,
      businessId,
      params.initialPayment.method,
      { registerSessionId: params.initialPayment.registerSessionId },
    );
    lines.push({
      accountId: account.id,
      credit: paid,
      locationId: expense.locationId,
      description: "Initial settlement",
    });
    // Keep the operational row and the GL line on the same payment account.
    if (paymentAccountId != null) {
      await tx
        .update(expensePayments)
        .set({ paymentAccountId })
        .where(eq(expensePayments.id, params.initialPayment.paymentId));
    }
  }
  const unpaid = roundMoney(amount - paid);
  if (unpaid > 0.005) {
    lines.push({
      accountCode: "2010",
      credit: unpaid,
      locationId: expense.locationId,
      description: "Unsettled expense payable",
    });
  }

  await postJournalEntry(tx, {
    businessId,
    memo: `Expense: ${expense.title}`,
    sourceType: "expense",
    sourceId: expense.id,
    cashFlowCategory: "operating",
    lines,
    actorUserId: params.actorUserId,
  });
}

/** Settlement entry: DR 2010 payable / CR cash account. */
export async function postExpensePaymentLedgerEntry(
  tx: Tx,
  params: {
    businessId: number;
    paymentId: number;
    amount: number;
    method: string;
    registerSessionId: number | null;
    locationId: number | null;
    actorUserId: number | null;
  },
): Promise<void> {
  const { businessId } = params;
  if (!(await isLedgerActivatedInTx(tx, businessId))) return;

  const amount = roundMoney(params.amount);
  const { account, paymentAccountId } = await resolveCashAccountForMethod(
    tx,
    businessId,
    params.method,
    { registerSessionId: params.registerSessionId },
  );
  if (paymentAccountId != null) {
    await tx
      .update(expensePayments)
      .set({ paymentAccountId })
      .where(eq(expensePayments.id, params.paymentId));
  }

  await postJournalEntry(tx, {
    businessId,
    memo: `Expense settlement ${params.paymentId}`,
    sourceType: "expense_payment",
    sourceId: params.paymentId,
    cashFlowCategory: "operating",
    lines: [
      {
        accountCode: "2010",
        debit: amount,
        locationId: params.locationId,
        description: "Expense payable settled",
      },
      {
        accountId: account.id,
        credit: amount,
        locationId: params.locationId,
        description: `Settlement (${params.method})`,
      },

    ],
    actorUserId: params.actorUserId,
  });
}

/** Void an expense: reverse its accrual entry (posted entries are immutable). */
export async function reverseExpenseLedgerEntry(
  tx: Tx,
  params: { businessId: number; expenseId: number; reason: string; actorUserId: number | null },
): Promise<void> {
  const { businessId } = params;
  if (!(await isLedgerActivatedInTx(tx, businessId))) return;
  const posted = await findPostedEntryBySource(tx, businessId, "expense", params.expenseId);
  if (!posted) return;
  await reverseEntry(tx, {
    businessId,
    entryId: posted.id,
    reason: params.reason,
    actorUserId: params.actorUserId,
  });
}

/** Void a settlement: reverse its payment entry. */
export async function reverseExpensePaymentLedgerEntry(
  tx: Tx,
  params: { businessId: number; paymentId: number; reason: string; actorUserId: number | null },
): Promise<void> {
  const { businessId } = params;
  if (!(await isLedgerActivatedInTx(tx, businessId))) return;
  const posted = await findPostedEntryBySource(tx, businessId, "expense_payment", params.paymentId);
  if (!posted) return;
  await reverseEntry(tx, {
    businessId,
    entryId: posted.id,
    reason: params.reason,
    actorUserId: params.actorUserId,
  });
}
