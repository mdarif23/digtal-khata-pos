/**
 * Unit tests for the purchase payment-cap math (D1-01/D1-03):
 * - the received-value basis is INVOICE-adjusted (line tax/discount +
 *   order-level discount/tax/shipping allocated over the received share) so
 *   a fully received purchase can always be paid in full;
 * - paymentStatus is due-authoritative — due 0 is "paid" no matter which
 *   flow brought it there.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculatePaymentStatus,
  calculatePayments,
  invoiceAdjustedReceivedAmount,
} from "../modules/purchases/receive/receive.calculations.js";

describe("invoiceAdjustedReceivedAmount (D1-01)", () => {
  it("fully received + shipping reaches the full invoice total", () => {
    // 10 × ৳100 + ৳50 shipping: the raw batch basis was ৳1000 — the
    // supplier could never be paid the last ৳50.
    const adjusted = invoiceAdjustedReceivedAmount({
      baseReceivedAmount: 1000,
      lineItems: [{ quantity: 10, receivedQuantity: 10, unitCost: 100 }],
      shippingCost: 50,
    });
    assert.equal(adjusted, 1050);
  });

  it("allocates order charges proportionally for a partial receive", () => {
    const adjusted = invoiceAdjustedReceivedAmount({
      baseReceivedAmount: 500,
      lineItems: [{ quantity: 10, receivedQuantity: 5, unitCost: 100 }],
      shippingCost: 50,
      orderTax: 30,
    });
    // 5 × 100 + (500/1000) × 80
    assert.equal(adjusted, 540);
  });

  it("adds line tax and nets line discount on the received share", () => {
    const adjusted = invoiceAdjustedReceivedAmount({
      baseReceivedAmount: 1000,
      lineItems: [
        {
          quantity: 10,
          receivedQuantity: 10,
          unitCost: 100,
          discount: 20,
          tax: 10,
        },
      ],
    });
    // 10 × 100 + 1 × (10 − 20)
    assert.equal(adjusted, 990);
  });

  it("nets an order-level discount (charge share can be negative)", () => {
    const adjusted = invoiceAdjustedReceivedAmount({
      baseReceivedAmount: 500,
      lineItems: [{ quantity: 10, receivedQuantity: 5, unitCost: 100 }],
      orderDiscount: 60,
      shippingCost: 50,
    });
    // 5 × 100 + 0.5 × (50 − 60)
    assert.equal(adjusted, 495);
  });

  it("clamps the order-charge share at fully received (over-receive)", () => {
    const adjusted = invoiceAdjustedReceivedAmount({
      baseReceivedAmount: 1000,
      lineItems: [{ quantity: 10, receivedQuantity: 10, unitCost: 100 }],
      shippingCost: 50,
    });
    assert.equal(adjusted, 1050);
    // The min() against the invoice total in calculatePayments caps any
    // over-received value — the share itself never exceeds 1.
  });

  it("never returns a negative basis", () => {
    const adjusted = invoiceAdjustedReceivedAmount({
      baseReceivedAmount: 0,
      lineItems: [
        { quantity: 5, receivedQuantity: 0, unitCost: 100, discount: 999 },
      ],
    });
    assert.equal(adjusted, 0);
  });
});

describe("calculatePaymentStatus (D1-03)", () => {
  it("reports paid when the due reached zero via a return", () => {
    // Return flow: paid 500 of a 1000 invoice, supplier returned 500 →
    // due 0. The old total-based rule called this "partial" forever.
    assert.equal(calculatePaymentStatus(500, 0), "paid");
  });

  it("reports partial while a due remains", () => {
    assert.equal(calculatePaymentStatus(500, 500), "partial");
  });

  it("reports unpaid when nothing has been paid", () => {
    assert.equal(calculatePaymentStatus(0, 1000), "unpaid");
  });

  it("tolerates float noise on a zero due", () => {
    // The due arrives pre-rounded from calculatePayments; sub-cent noise
    // rounds to zero on the money grid.
    assert.equal(calculatePaymentStatus(320.34, 0.004), "paid");
  });
});

describe("calculatePayments — cap interplay", () => {
  it("allows the full invoice payment once fully received (D1-01 repro)", () => {
    const result = calculatePayments({
      paidAmount: 0,
      paymentAmount: 1050,
      totalAmount: 1050,
      receivedAmount: 1050,
    });
    assert.equal(result.updatedPaidAmount, 1050);
    assert.equal(result.updatedDueAmount, 0);
  });

  it("still caps payment at the received basis for a partial receive", () => {
    assert.throws(
      () =>
        calculatePayments({
          paidAmount: 0,
          paymentAmount: 1000,
          totalAmount: 1000,
          receivedAmount: 500,
        }),
      /available received balance/,
    );
  });
});
