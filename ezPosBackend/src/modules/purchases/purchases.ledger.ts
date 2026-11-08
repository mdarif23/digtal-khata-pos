import { eq } from "drizzle-orm";
import { purchasePayments } from "../../db/schema/purchasePayments.js";
import type { Tx } from "../../services/audit.js";
import {
  isLedgerActivatedInTx,
  postJournalEntry,
  resolveCashAccountForMethod,
} from "../../services/ledger.js";
import { roundMoney } from "../../utils/roundMoney.js";

/**
 * Purchases → GL posting hooks (Finance & Growth Stage 3).
 *
 * Treatment:
 *   Receive:  DR 1050 Inventory (received value at session unit cost)
 *             DR 1045 VAT Input (line-tax share of accepted quantities)
 *             CR 2010 Accounts Payable (received value + tax share)
 *             Over-received value is included — the GL payable tracks
 *             goods-received-not-paid; the reconciliation view explains the
 *             gap against the invoice-based supplier payable.
 *   Payment:  DR 2010 / CR cash account (method-mapped, payment_account_id
 *             stamped on the operational row).
 *   Return:   DR 2010 return total / CR 1050 batch carrying value; the
 *             residual (tax-discount spread vs carrying value) goes to
 *             4040 Other Income (credit) or 5070 Shrinkage (debit).
 *   Cancellation (shortage): no GL entry — goods were never received, so
 *   nothing was posted for them (the invoice payable is reduced
 *   operationally only).
 */

/** Purchase payment methods → cash-account type mapping. */
function purchaseMethodCashType(method: string): "cash" | "bank" {
  return method === "cash" ? "cash" : "bank";
}

export interface ReceiveLineValue {
  /** Accepted quantity × session unit cost for the line. */
  value: number;
  /** Line tax × (accepted / ordered) — the recoverable input share. */
  vatShare: number;
}

/** Receive entry (one per receiving submission). */
export async function postPurchaseReceiveLedgerEntry(
  tx: Tx,
  params: {
    businessId: number;
    purchaseId: number;
    /** First receiving-record id of this submission — the idempotency key. */
    receiveEventId: number | null;
    lines: ReceiveLineValue[];
    locationId: number | null;
    actorUserId: number | null;
  },
): Promise<void> {
  const { businessId } = params;
  if (!(await isLedgerActivatedInTx(tx, businessId))) return;

  const receivedValue = roundMoney(
    params.lines.reduce((sum, line) => sum + line.value, 0),
  );
  const vatShare = roundMoney(params.lines.reduce((sum, line) => sum + line.vatShare, 0));
  const total = roundMoney(receivedValue + vatShare);
  if (total <= 0.005) return;

  const lines: Parameters<typeof postJournalEntry>[1]["lines"] = [
    {
      accountCode: "1050",
      debit: receivedValue,
      locationId: params.locationId,
      description: "Goods received at cost",
    },
  ];
  if (vatShare > 0.005) {
    lines.push({
      accountCode: "1045",
      debit: vatShare,
      locationId: params.locationId,
      description: "Recoverable VAT on received goods",
    });
  }
  lines.push({
    accountCode: "2010",
    credit: total,
    locationId: params.locationId,
    description: "Supplier payable for received goods",
  });

  await postJournalEntry(tx, {
    businessId,
    memo: `Goods received on purchase ${params.purchaseId}`,
    sourceType: "purchase_receive",
    sourceId: params.receiveEventId,
    cashFlowCategory: "operating",
    lines,
    actorUserId: params.actorUserId,
  });
}

/** Supplier payment (at-receive or standalone): DR 2010 / CR cash. */
export async function postPurchasePaymentLedgerEntry(
  tx: Tx,
  params: {
    businessId: number;
    paymentId: number;
    purchaseId: number;
    amount: number;
    method: string;
    locationId: number | null;
    actorUserId: number | null;
  },
): Promise<void> {
  const { businessId } = params;
  if (!(await isLedgerActivatedInTx(tx, businessId))) return;

  const amount = roundMoney(params.amount);
  if (amount <= 0.005) return;
  const { account, paymentAccountId } = await resolveCashAccountForMethod(
    tx,
    businessId,
    purchaseMethodCashType(params.method),
  );
  if (paymentAccountId != null) {
    await tx
      .update(purchasePayments)
      .set({ paymentAccountId })
      .where(eq(purchasePayments.id, params.paymentId));
  }

  await postJournalEntry(tx, {
    businessId,
    memo: `Supplier payment on purchase ${params.purchaseId}`,
    sourceType: "purchase_payment",
    sourceId: params.paymentId,
    cashFlowCategory: "operating",
    lines: [
      {
        accountCode: "2010",
        debit: amount,
        locationId: params.locationId,
        description: "Supplier payable settled",
      },
      {
        accountId: account.id,
        credit: amount,
        locationId: params.locationId,
        description: `Payment (${params.method})`,
      },
    ],
    actorUserId: params.actorUserId,
  });
}

/** Purchase return: payable relieved, inventory reduced at carrying value. */
export async function postPurchaseReturnLedgerEntry(
  tx: Tx,
  params: {
    businessId: number;
    returnId: number;
    purchaseId: number;
    totalAmount: number;
    batchValue: number;
    locationId: number | null;
    actorUserId: number | null;
  },
): Promise<void> {
  const { businessId } = params;
  if (!(await isLedgerActivatedInTx(tx, businessId))) return;

  const total = roundMoney(params.totalAmount);
  const batchValue = roundMoney(params.batchValue);
  if (total <= 0.005) return;

  const lines: Parameters<typeof postJournalEntry>[1]["lines"] = [
    {
      accountCode: "2010",
      debit: total,
      locationId: params.locationId,
      description: "Supplier payable reduced by return",
    },
    {
      accountCode: "1050",
      credit: Math.min(batchValue, total),
      locationId: params.locationId,
      description: "Returned goods at batch carrying value",
    },
  ];
  const residual = roundMoney(total - batchValue);
  if (residual > 0.005) {
    // Credited more than the batches carried (line tax/discount spread) —
    // the excess is a gain on settlement.
    lines.push({
      accountCode: "4040",
      credit: residual,
      locationId: params.locationId,
      description: "Settlement gain on purchase return",
    });
  } else if (residual < -0.005) {
    // Credited less than carrying value — the loss leaves with the goods.
    lines.push({
      accountCode: "5070",
      debit: -residual,
      locationId: params.locationId,
      description: "Settlement loss on purchase return",
    });
  }

  await postJournalEntry(tx, {
    businessId,
    memo: `Purchase return on purchase ${params.purchaseId}`,
    sourceType: "purchase_return",
    sourceId: params.returnId,
    cashFlowCategory: "operating",
    lines,
    actorUserId: params.actorUserId,
  });
}
