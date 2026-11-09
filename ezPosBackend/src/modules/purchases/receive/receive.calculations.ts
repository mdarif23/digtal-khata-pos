import { BadRequestError } from "../../../utils/handleError.js";
import { roundMoney } from "../../../utils/roundMoney.js";

// Pure purchase math shared by the receive flow and due-management supplier
// payments. No SQL here: callers supply the received value (computed from
// inventory batches — see getPurchaseReceivedAmountInTx) so both flows agree
// on the same definition of "value of goods received".

export type PurchaseStatus = "received" | "partially_received";
export type PaymentStatus = "paid" | "unpaid" | "partial";

type StatusItems = {
  quantity: number;
  receivedQuantity: number;
  cancelledQuantity?: number;
};

export function calculatePurchaseStatus(
  allPurchaseItems: StatusItems[],
): PurchaseStatus {
  // Outstanding = ordered − received − cancelled. A line is complete when
  // nothing is outstanding: received units plus short-receiving
  // cancellations cover the order. Cancelled units never mark a purchase
  // complete prematurely — they ARE the resolution.
  const allItemsFullyReceived =
    allPurchaseItems.length > 0 &&
    allPurchaseItems.every(
      (item) =>
        item.receivedQuantity + Number(item.cancelledQuantity ?? 0) >=
        item.quantity,
    );

  return allItemsFullyReceived ? "received" : "partially_received";
}

export function calculatePayments({
  paidAmount,
  paymentAmount,
  totalAmount,
  receivedAmount,
  cancelledAmount = 0,
  /** Invoice value credited back by purchase returns (audit FIN-8). */
  returnedAmount = 0,
}: {
  paidAmount: number;
  paymentAmount: number;
  totalAmount: number;
  receivedAmount: number;
  /** Invoice value written off by short-receiving cancellations (Phase 3). */
  cancelledAmount?: number;
  /** Invoice value credited back by purchase returns (audit FIN-8). */
  returnedAmount?: number;
}): {
  updatedPaidAmount: number;
  receivedAmount: number;
  updatedDueAmount: number;
  newPaymentAmount: number;
  paymentLimit: number;
} {
  const currentPaidAmount = Number(paidAmount ?? 0);
  const newPaymentAmount = Number(paymentAmount ?? 0);
  // The effective invoice total nets out cancelled quantities — a payable
  // reduction must survive subsequent payments.
  const effectiveTotal = Math.max(
    0,
    totalAmount - Math.max(0, cancelledAmount) - Math.max(0, returnedAmount),
  );

  // You can only pay for goods that have actually been received, and never
  // beyond the (cancellation-adjusted) invoice total.
  const paymentLimit = Math.max(
    0,
    Math.min(
      receivedAmount - currentPaidAmount,
      effectiveTotal - currentPaidAmount,
    ),
  );

  if (newPaymentAmount < 0) {
    throw new BadRequestError("Payment amount cannot be negative.");
  }

  if (newPaymentAmount > paymentLimit) {
    throw new BadRequestError(
      `Payment cannot be greater than the available received balance (${paymentLimit.toFixed(2)}).`,
    );
  }

  const updatedPaidAmount = currentPaidAmount + newPaymentAmount;

  const updatedDueAmount = Math.max(0, effectiveTotal - updatedPaidAmount);

  return {
    updatedPaidAmount,
    receivedAmount,
    updatedDueAmount,
    newPaymentAmount,
    paymentLimit,
  };
}

export function calculatePaymentStatus(
  updatedPaidAmount: number,
  totalAmount: number,
): PaymentStatus {
  if (updatedPaidAmount <= 0) {
    return "unpaid";
  }
  return updatedPaidAmount < totalAmount ? "partial" : "paid";
}

/**
 * Batch-authoritative received value (D1 decision): every received unit has
 * an inventory_batches row whose purchase_price is the cost entered at ITS
 * receive session, so Σ quantity_received × purchase_price is the true value
 * of goods received even across sessions at different costs.
 *
 * Fallback for legacy purchases received before batch rows were written:
 * if the purchase has received units but no batches at all, fall back to
 * Σ receivedQuantity × unit_cost (the line cost).
 */
export function receivedAmountFromBatches(
  batchTotal: number,
  lineItems: (StatusItems & { unitCost: number })[],
): number {
  if (batchTotal > 0) return roundMoney(batchTotal);
  const lineTotal = lineItems.reduce(
    (sum, item) =>
      sum + Number(item.receivedQuantity ?? 0) * Number(item.unitCost ?? 0),
    0,
  );
  return roundMoney(lineTotal);
}
