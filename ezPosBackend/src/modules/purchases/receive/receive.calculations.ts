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
  // beyond the (cancellation-adjusted) invoice total. Rounded to the 2-dp
  // money grid: float subtraction (345.66 − 25.32 = 320.33999999999996)
  // must not reject a legitimate full-balance payment of ৳320.34.
  const paymentLimit = roundMoney(
    Math.max(
      0,
      Math.min(
        receivedAmount - currentPaidAmount,
        effectiveTotal - currentPaidAmount,
      ),
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

  const updatedPaidAmount = roundMoney(currentPaidAmount + newPaymentAmount);

  const updatedDueAmount = roundMoney(
    Math.max(0, effectiveTotal - updatedPaidAmount),
  );

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
  dueAmount: number,
): PaymentStatus {
  if (updatedPaidAmount <= 0) {
    return "unpaid";
  }
  // Due-authoritative (same convention as the cancel/return flows): a
  // fully-settled invoice is "paid" no matter which flow brought the due
  // to zero — comparing paid against the RAW total marked a returned
  // purchase with due=0 as "partial" forever.
  return roundMoney(dueAmount) <= 0 ? "paid" : "partial";
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

type InvoiceLine = StatusItems & {
  unitCost: number;
  /** Line-level discount money (order value nets it, like the cancellation amortization). */
  discount?: number | null;
  /** Line-level tax money (order value includes it, like the cancellation amortization). */
  tax?: number | null;
};

/**
 * Invoice-adjusted received value (D1-01): batch rows price lines at
 * unit_cost only, but the invoice also carries line tax/discount and the
 * order-level discount/tax/shipping. A fully received purchase must be
 * payable in full — payment for a 10 × ৳100 invoice with ৳50 shipping was
 * capped at ৳1000 forever.
 *
 * Line components are added per line on the RECEIVED share
 * (receivedQty/orderedQty, clamped to one — over-received units stay
 * capped by the invoice total via the payment cap's min()); the order-level
 * net charges (tax + shipping − discount) are allocated proportionally to
 * the received share of the invoiced line value — the same per-unit
 * amortization the short-receive cancellation uses for its line value
 * (quantity × unitCost − discount + tax) / quantity.
 */
export function invoiceAdjustedReceivedAmount({
  baseReceivedAmount,
  lineItems,
  orderDiscount = 0,
  orderTax = 0,
  shippingCost = 0,
}: {
  baseReceivedAmount: number;
  lineItems: InvoiceLine[];
  orderDiscount?: number;
  orderTax?: number;
  shippingCost?: number;
}): number {
  let receivedLineInvoiceValue = 0;
  let receivedUnitCostValue = 0;
  let orderedLineInvoiceValue = 0;
  for (const item of lineItems) {
    const orderedQty = Number(item.quantity ?? 0);
    const unitCost = Number(item.unitCost ?? 0);
    const lineDiscount = Number(item.discount ?? 0);
    const lineTax = Number(item.tax ?? 0);
    if (orderedQty <= 0) continue;
    const orderedValue = orderedQty * unitCost - lineDiscount + lineTax;
    if (orderedValue <= 0) continue; // degenerate line — nothing to allocate
    orderedLineInvoiceValue += orderedValue;

    const receivedQty = Math.min(
      Number(item.receivedQuantity ?? 0),
      orderedQty,
    );
    if (receivedQty <= 0) continue;
    const receivedShare = receivedQty / orderedQty;
    receivedUnitCostValue += receivedQty * unitCost;
    receivedLineInvoiceValue +=
      receivedQty * unitCost + receivedShare * (lineTax - lineDiscount);
  }

  // The base is batch-authoritative (actual per-session costs); the line
  // adjustment layer only adds the invoice components batches don't carry.
  const lineAdjustments = receivedLineInvoiceValue - receivedUnitCostValue;
  const orderCharges =
    Number(orderTax ?? 0) + Number(shippingCost ?? 0) - Number(orderDiscount ?? 0);
  const chargeShare =
    orderedLineInvoiceValue > 0
      ? (receivedLineInvoiceValue / orderedLineInvoiceValue) * orderCharges
      : 0;

  return roundMoney(
    Math.max(
      0,
      Number(baseReceivedAmount ?? 0) + lineAdjustments + chargeShare,
    ),
  );
}
