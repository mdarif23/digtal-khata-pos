import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allocateOrderDiscount,
  calculatePurchaseFinancials,
} from "./purchaseFinancials.service.js";

/** The master prompt's §2.4 worked example. */
const invoiceExample = {
  lines: [{ quantity: 100, unitPrice: 100, discount: 0, tax: 0 }],
  orderDiscount: 500,
  orderTax: 450,
  supplierShipping: 300,
  otherSupplierCharges: [{ label: "packing", amount: 100 }],
};

describe("calculatePurchaseFinancials", () => {
  it("computes the invoice example: 10,000 − 500 + 450 + 300 + 100 = 10,350", () => {
    const summary = calculatePurchaseFinancials({
      ...invoiceExample,
      lines: [{ quantity: 100, unitPrice: 100, discount: 0, tax: 0 }],
    });
    assert.equal(summary.itemsSubtotal, 10000);
    assert.equal(summary.orderDiscount, 500);
    assert.equal(summary.orderTax, 450);
    assert.equal(summary.supplierShipping, 300);
    assert.equal(summary.otherSupplierCharges, 100);
    assert.equal(summary.grandTotal, 10350);
    // Supplier charges are capitalization-eligible by default.
    assert.equal(summary.capitalizableSupplierCharges, 400);
  });

  it("rounds per line then sums (historical createPurchase math preserved)", () => {
    // 3 × 33.335 − 0 + 0 → per-line 100.005 → round2 100.01 (banker's? No:
    // toFixed-style half-away per the historical code path).
    const summary = calculatePurchaseFinancials({
      lines: [
        { quantity: 3, unitPrice: 33.335, discount: 0, tax: 0 },
        { quantity: 1, unitPrice: 10.005, discount: 0, tax: 0 },
      ],
      orderDiscount: 0,
      orderTax: 0,
      supplierShipping: 0,
    });
    // Each line rounds to 2dp BEFORE summing — identical to the old inline
    // reduce, so totals cannot drift.
    assert.equal(summary.itemsSubtotal, 110.02);
    assert.equal(summary.grandTotal, 110.02);
  });

  it("carries line discounts and line taxes separately", () => {
    const summary = calculatePurchaseFinancials({
      lines: [
        { quantity: 2, unitPrice: 50, discount: 10, tax: 5 },
        { quantity: 1, unitPrice: 100, discount: 0, tax: 8 },
      ],
      orderDiscount: 20,
      orderTax: 12,
      supplierShipping: 30,
    });
    assert.equal(summary.itemsSubtotal, 203); // (100−10+5) + 108
    assert.equal(summary.lineDiscountTotal, 10);
    assert.equal(summary.lineTaxTotal, 13);
    assert.equal(summary.grandTotal, 225); // 203 − 20 + 12 + 30
  });

  it("resolves percentage discounts against the items subtotal", () => {
    const summary = calculatePurchaseFinancials({
      lines: [{ quantity: 10, unitPrice: 100, discount: 0, tax: 0 }],
      orderDiscount: 5,
      orderDiscountBasis: "percentage",
      orderTax: 0,
      supplierShipping: 0,
    });
    assert.equal(summary.orderDiscount, 50);
    assert.equal(summary.grandTotal, 950);
  });

  it("rejects discounts exceeding the subtotal and negative values", () => {
    assert.throws(
      () =>
        calculatePurchaseFinancials({
          lines: [{ quantity: 1, unitPrice: 100, discount: 0, tax: 0 }],
          orderDiscount: 150,
          orderTax: 0,
          supplierShipping: 0,
        }),
      /cannot exceed the items subtotal/,
    );
    assert.throws(
      () =>
        calculatePurchaseFinancials({
          lines: [{ quantity: 1, unitPrice: 100, discount: 0, tax: 0 }],
          orderDiscount: -5,
          orderTax: 0,
          supplierShipping: 0,
        }),
      /cannot be negative/,
    );
    assert.throws(
      () =>
        calculatePurchaseFinancials({
          lines: [{ quantity: 1, unitPrice: 100, discount: 200, tax: 0 }],
          orderDiscount: 0,
          orderTax: 0,
          supplierShipping: 0,
        }),
      /cannot exceed the line amount/,
    );
    assert.throws(
      () =>
        calculatePurchaseFinancials({
          lines: [],
          orderDiscount: 0,
          orderTax: 0,
          supplierShipping: 0,
        }),
      /At least one purchase item/,
    );
  });

  it("supports zero-value purchases", () => {
    const summary = calculatePurchaseFinancials({
      lines: [{ quantity: 5, unitPrice: 0, discount: 0, tax: 0 }],
      orderDiscount: 0,
      orderTax: 0,
      supplierShipping: 0,
    });
    assert.equal(summary.itemsSubtotal, 0);
    assert.equal(summary.grandTotal, 0);
  });

  it("honors capitalization eligibility on supplier charges", () => {
    const summary = calculatePurchaseFinancials({
      lines: [{ quantity: 1, unitPrice: 100, discount: 0, tax: 0 }],
      orderDiscount: 0,
      orderTax: 0,
      supplierShipping: 300,
      otherSupplierCharges: [
        { label: "capitalizable handling", amount: 100 },
        { label: "period charge", amount: 50, capitalizationEligible: false },
      ],
    });
    assert.equal(summary.otherSupplierCharges, 150);
    assert.equal(summary.grandTotal, 550);
    assert.equal(summary.capitalizableSupplierCharges, 400); // 300 + 100
  });
});

describe("allocateOrderDiscount", () => {
  it("splits proportionally with the residual absorbed deterministically", () => {
    // 100 over three equal lines → 33.34 / 33.33 / 33.33 (residual to the
    // largest fractional part via the exact allocator).
    const parts = allocateOrderDiscount(
      [
        { quantity: 1, unitPrice: 100, discount: 0, tax: 0 },
        { quantity: 1, unitPrice: 100, discount: 0, tax: 0 },
        { quantity: 1, unitPrice: 100, discount: 0, tax: 0 },
      ],
      100,
    );
    assert.equal(
      parts.reduce((sum, value) => sum + value, 0),
      100,
    );
    assert.deepEqual(
      parts.map((value) => Number(value.toFixed(2))),
      [33.34, 33.33, 33.33],
    );
  });

  it("allocates by net line value, skipping zero-value lines", () => {
    const parts = allocateOrderDiscount(
      [
        { quantity: 10, unitPrice: 90, discount: 0, tax: 0 }, // 900
        { quantity: 10, unitPrice: 10, discount: 0, tax: 0 }, // 100
        { quantity: 5, unitPrice: 0, discount: 0, tax: 0 }, // 0
      ],
      100,
    );
    assert.equal(parts[0], 90);
    assert.equal(parts[1], 10);
    assert.equal(parts[2], 0);
  });

  it("rejects a discount when no line carries value", () => {
    assert.throws(
      () =>
        allocateOrderDiscount(
          [{ quantity: 5, unitPrice: 0, discount: 0, tax: 0 }],
          10,
        ),
      /no line carries a positive value/,
    );
  });
});
