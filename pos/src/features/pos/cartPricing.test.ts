import { describe, expect, it } from "vitest";
import {
  calcDiscountAmount,
  getCartTotals,
  getLinePricing,
  money,
  type DiscountInput,
} from "./cartPricing";

// The client's totals are display-only (the backend re-computes from DB
// prices), but they are the OFFLINE fallback and the payment-amount source,
// so they must agree with the backend mirror
// (ezPosBackend/src/modules/sales/utils/cartPricing.test.ts) to the poisha.

const item = (price: number, quantity: number, discount?: DiscountInput) => ({
  quantity,
  discount,
  variants: [{ sellingPrice: price }],
});

describe("money", () => {
  it("rounds half-up on the poisha and defeats float drift", () => {
    expect(money(0.1 + 0.2)).toBe(0.3);
    expect(money(2.675)).toBe(2.68);
    expect(money(1.005)).toBe(1.01);
    expect(money(10)).toBe(10);
  });
});

describe("calcDiscountAmount", () => {
  it("returns 0 for a missing discount or a non-positive base", () => {
    expect(calcDiscountAmount(200, null)).toBe(0);
    expect(calcDiscountAmount(200, undefined)).toBe(0);
    expect(calcDiscountAmount(0, { type: "percentage", value: 50 })).toBe(0);
  });

  it("computes percentage discounts", () => {
    expect(calcDiscountAmount(200, { type: "percentage", value: 10 })).toBe(20);
    expect(calcDiscountAmount(200, { type: "percentage", value: 0 })).toBe(0);
  });

  it("clamps percentage discounts to 100%", () => {
    expect(calcDiscountAmount(200, { type: "percentage", value: 150 })).toBe(
      200,
    );
  });

  it("computes fixed discounts clamped to the base", () => {
    expect(calcDiscountAmount(200, { type: "fixed", value: 30 })).toBe(30);
    expect(calcDiscountAmount(200, { type: "fixed", value: 250 })).toBe(200);
    expect(calcDiscountAmount(200, { type: "fixed", value: -5 })).toBe(0);
  });

  it("coerces string values", () => {
    expect(calcDiscountAmount(200, { type: "fixed", value: "25" })).toBe(25);
  });
});

describe("getLinePricing", () => {
  it("prices a line without a discount", () => {
    expect(getLinePricing("199.99", "3", null)).toEqual({
      base: 599.97,
      discountAmount: 0,
      total: 599.97,
    });
  });

  it("applies percentage and fixed line discounts", () => {
    expect(getLinePricing(100, 2, { type: "percentage", value: 10 })).toEqual({
      base: 200,
      discountAmount: 20,
      total: 180,
    });
    expect(getLinePricing(10, 3, { type: "fixed", value: 5 })).toEqual({
      base: 30,
      discountAmount: 5,
      total: 25,
    });
  });

  it("never discounts below a zero line total", () => {
    expect(getLinePricing(10, 1, { type: "fixed", value: 99 })).toEqual({
      base: 10,
      discountAmount: 10,
      total: 0,
    });
  });
});

describe("getCartTotals", () => {
  it("applies item discounts, then the cart discount, then VAT", () => {
    const t = getCartTotals(
      [item(100, 1), item(200, 2, { type: "percentage", value: 10 })],
      { type: "fixed", value: 60 },
      5,
    );
    expect(t.itemsBase).toBe(500);
    expect(t.itemDiscount).toBe(40);
    expect(t.itemsTotal).toBe(460);
    expect(t.cartDiscountAmount).toBe(60);
    expect(t.afterDiscount).toBe(400);
    expect(t.vat).toBe(20);
    expect(t.finalTotal).toBe(420);
  });

  it("returns zero totals for an empty cart", () => {
    const t = getCartTotals([], null, 15);
    expect(t.itemsBase).toBe(0);
    expect(t.finalTotal).toBe(0);
    expect(t.vat).toBe(0);
  });

  it("skips lines without a variant price", () => {
    const t = getCartTotals(
      [{ quantity: 2, discount: null, variants: [] }],
      null,
      10,
    );
    expect(t.itemsBase).toBe(0);
    expect(t.finalTotal).toBe(0);
  });

  it("clamps the VAT percent into [0, 100]", () => {
    const high = getCartTotals([item(100, 1)], null, 150);
    expect(high.vatPercent).toBe(100);
    expect(high.vat).toBe(100);
    expect(high.finalTotal).toBe(200);

    const low = getCartTotals([item(100, 1)], null, -10);
    expect(low.vatPercent).toBe(0);
    expect(low.vat).toBe(0);
    expect(low.finalTotal).toBe(100);
  });

  it("supports percentage cart discounts", () => {
    const t = getCartTotals(
      [item(100, 1), item(200, 2, { type: "percentage", value: 10 })],
      { type: "percentage", value: 10 },
      10,
    );
    expect(t.itemsTotal).toBe(460);
    expect(t.cartDiscountAmount).toBe(46);
    expect(t.afterDiscount).toBe(414);
    expect(t.vat).toBe(41.4);
    expect(t.finalTotal).toBe(455.4);
  });

  it("survives the classic floating-point cart (0.1 × 3)", () => {
    const t = getCartTotals([item(0.1, 1), item(0.1, 1), item(0.1, 1)], null, 0);
    expect(t.itemsBase).toBe(0.3);
    expect(t.finalTotal).toBe(0.3);
  });
});
