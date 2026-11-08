import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calcDiscountAmount,
  getCartTotals,
  getCartTotalsWithTaxRules,
  getLinePricing,
} from "./cartPricing.js";

// Server-side re-computation of the client cart math. The client totals are
// display-only; these are the values that land in the database, so the
// expectations here are the money truth (mirrored by
// pos/src/features/pos/cartPricing.test.ts).

type Line = {
  variantId: number;
  unitPrice: number;
  quantity: number;
  discount: { type: "fixed" | "percentage"; value: number } | null;
};

const line = (
  variantId: number,
  unitPrice: number,
  quantity: number,
  discount: Line["discount"] = null,
): Line => ({ variantId, unitPrice, quantity, discount });

const rule = (rate: number, isInclusive: boolean) => ({
  taxRateId: rate,
  name: `rate-${rate}${isInclusive ? "-incl" : "-excl"}`,
  rate,
  isInclusive,
});

describe("legacy cart totals (server re-computation)", () => {
  it("prices a line and applies its discount", () => {
    assert.deepEqual(getLinePricing("199.99", "3", null), {
      base: 599.97,
      discountAmount: 0,
      total: 599.97,
    });
    assert.deepEqual(
      getLinePricing(100, 2, { type: "percentage", value: 10 }),
      { base: 200, discountAmount: 20, total: 180 },
    );
  });

  it("clamps discounts to [0, base] and percentages to [0, 100]", () => {
    assert.equal(calcDiscountAmount(200, { type: "percentage", value: 150 }), 200);
    assert.equal(calcDiscountAmount(200, { type: "fixed", value: 250 }), 200);
    assert.equal(calcDiscountAmount(200, { type: "fixed", value: -5 }), 0);
    assert.equal(calcDiscountAmount(0, { type: "percentage", value: 50 }), 0);
    assert.equal(calcDiscountAmount(200, null), 0);
  });

  it("applies item discounts, then the cart discount, then VAT", () => {
    const t = getCartTotals(
      [line(1, 100, 1), line(2, 200, 2, { type: "percentage", value: 10 })],
      { type: "fixed", value: 60 },
      5,
    );
    assert.equal(t.itemsBase, 500);
    assert.equal(t.itemDiscount, 40);
    assert.equal(t.itemsTotal, 460);
    assert.equal(t.cartDiscountAmount, 60);
    assert.equal(t.afterDiscount, 400);
    assert.equal(t.vat, 20);
    assert.equal(t.finalTotal, 420);
  });

  it("clamps the legacy VAT percent into [0, 100]", () => {
    const high = getCartTotals([line(1, 100, 1)], null, 150);
    assert.equal(high.vatPercent, 100);
    assert.equal(high.finalTotal, 200);

    const low = getCartTotals([line(1, 100, 1)], null, -10);
    assert.equal(low.vatPercent, 0);
    assert.equal(low.finalTotal, 100);
  });

  it("matches the client to the poisha on float-trap carts", () => {
    const t = getCartTotals(
      [line(1, 0.1, 1), line(2, 0.1, 1), line(3, 0.1, 1)],
      null,
      0,
    );
    assert.equal(t.itemsBase, 0.3);
    assert.equal(t.finalTotal, 0.3);
  });

  it("returns zero totals for an empty sale", () => {
    const t = getCartTotals([], null, 15);
    assert.equal(t.finalTotal, 0);
    assert.equal(t.vat, 0);
  });
});

describe("getCartTotalsWithTaxRules", () => {
  it("adds exclusive tax on top of the discounted base", () => {
    const items = [line(1, 100, 1), line(2, 50, 2)];
    const t = getCartTotalsWithTaxRules(
      items,
      { type: "fixed", value: 30 },
      new Map([[1, [rule(10, false)]]]),
    );
    // Pro-rata cart discount: 30 splits evenly across two equal lines.
    assert.equal(t.cartDiscountAmount, 30);
    assert.equal(t.perLine[0]!.taxAmount, 8.5); // (100 − 15) × 10%
    assert.equal(t.perLine[1]!.taxAmount, 0);
    assert.equal(t.exclusiveTaxTotal, 8.5);
    assert.equal(t.inclusiveTaxTotal, 0);
    assert.equal(t.vat, 8.5);
    assert.equal(t.finalTotal, 178.5); // 170 after discount + 8.5 tax
  });

  it("extracts inclusive tax from prices that already contain it", () => {
    const t = getCartTotalsWithTaxRules(
      [line(1, 110, 1)],
      null,
      new Map([[1, [rule(10, true)]]]),
    );
    assert.equal(t.inclusiveTaxTotal, 10);
    assert.equal(t.vat, 10);
    assert.equal(t.finalTotal, 110); // inclusive tax is NOT added again
    assert.equal(t.perLine[0]!.detail[0]!.amount, 10);
    assert.equal(t.perLine[0]!.taxAmount, 10);
  });

  it("splits a combined inclusive rate across rules proportionally", () => {
    const t = getCartTotalsWithTaxRules(
      [line(1, 105, 1)],
      null,
      new Map([[1, [rule(5, true), rule(5, true)]]]),
    );
    // 105 − 105/1.1 = 9.5454… → 9.55, split 4.78 + 4.77 (last absorbs).
    assert.equal(t.inclusiveTaxTotal, 9.55);
    assert.equal(t.vat, 9.55);
    assert.equal(t.finalTotal, 105);
    const amounts = t.perLine[0]!.detail.map((d) => d.amount);
    assert.deepEqual(amounts, [4.78, 4.77]);
    assert.equal(
      Math.round((amounts[0]! + amounts[1]!) * 100) / 100,
      9.55,
    );
  });

  it("allocates the cart discount pro-rata; the last line absorbs the remainder", () => {
    const items = [line(1, 33.33, 1), line(2, 33.33, 1), line(3, 33.34, 1)];
    const rules = new Map([
      [1, [rule(10, false)]],
      [2, [rule(10, false)]],
      [3, [rule(10, false)]],
    ]);
    const t = getCartTotalsWithTaxRules(items, { type: "fixed", value: 10 }, rules);
    // Allocations: 3.33 + 3.33 + 3.34 (remainder absorbed) → bases 30/30/30.
    assert.deepEqual(
      t.perLine.map((l) => l.taxAmount),
      [3, 3, 3],
    );
    assert.equal(t.vat, 9);
    assert.equal(t.afterDiscount, 90);
    assert.equal(t.finalTotal, 99);
  });

  it("treats lines without rules as exempt — no legacy VAT is applied", () => {
    const t = getCartTotalsWithTaxRules(
      [line(1, 100, 1), line(2, 50, 1)],
      null,
      new Map([[1, [rule(10, false)]]]),
    );
    assert.equal(t.perLine[0]!.taxAmount, 10);
    assert.equal(t.perLine[1]!.taxAmount, 0);
    assert.equal(t.vat, 10);
    assert.equal(t.finalTotal, 160);
  });

  it("handles a cart where every line is exempt", () => {
    const t = getCartTotalsWithTaxRules(
      [line(1, 100, 1), line(2, 50, 1)],
      null,
      new Map(),
    );
    assert.equal(t.vat, 0);
    assert.equal(t.finalTotal, 150);
  });
});

// ---------------------------------------------------------------------------
// Customer-group discounts (Phase 4): group amounts are computed server-side
// and arrive as final amounts; the engine allocates them for tax + snapshots.
// ---------------------------------------------------------------------------

describe("customer-group discounts", () => {
  it("whole-cart group discount applies BEFORE the manual cart discount (legacy path)", () => {
    // 100 + 100 = 200; group 10% computed outside = 20; manual 10% bases on
    // the post-group 180 → 18; VAT 0.
    const t = getCartTotals(
      [line(1, 100, 1), line(2, 100, 1)],
      { type: "percentage", value: 10 },
      0,
      {
        cartAmounts: [{ refId: 7, amount: 20 }],
        lineAdjustments: [],
      },
    );
    assert.equal(t.groupCartAmount, 20);
    assert.equal(t.cartDiscountAmount, 18);
    assert.equal(t.afterDiscount, 162);
    assert.equal(t.finalTotal, 162);
    // Snapshot: 20 allocated pro-rata (10 + 10 here), attributed to row 7.
    assert.deepEqual(t.groupLineAdjustments[0], [{ refId: 7, amount: 10 }]);
    assert.deepEqual(t.groupLineAdjustments[1], [{ refId: 7, amount: 10 }]);
  });

  it("without group input the totals are bit-for-bit the pre-groups values", () => {
    const t = getCartTotals(
      [line(1, 100, 2), line(2, 50, 1)],
      { type: "fixed", value: 25 },
      15,
    );
    assert.equal(t.groupCartAmount, 0);
    assert.equal(t.cartDiscountAmount, 25);
    assert.equal(t.afterDiscount, 225);
    assert.equal(t.vat, 33.75);
    assert.equal(t.finalTotal, 258.75);
    assert.deepEqual(t.groupLineAdjustments, [[], []]);
  });

  it("line-scoped group discounts reduce the taxed base per line (rules path)", () => {
    // 100 + 50 lines; group takes 10 off line 1 and 5 off line 2.
    const t = getCartTotalsWithTaxRules(
      [line(1, 100, 1), line(2, 50, 1)],
      null,
      new Map([[1, [rule(10, false)]]]),
      {
        cartAmounts: [],
        lineAdjustments: [{ refId: 3, amount: 10 }, { refId: 3, amount: 5 }],
      },
    );
    // Line 1: 100 − 10 = 90 → 10% exclusive = 9. Line 2: 50 − 5 = 45, exempt.
    assert.deepEqual(t.perLine.map((l) => l.taxAmount), [9, 0]);
    assert.equal(t.lineGroupTotal, 15);
    assert.equal(t.afterDiscount, 135);
    assert.equal(t.finalTotal, 144);
    assert.deepEqual(t.perLine[0]!.groupAdjustments, [{ refId: 3, amount: 10 }]);
    assert.deepEqual(t.perLine[1]!.groupAdjustments, [{ refId: 3, amount: 5 }]);
  });

  it("whole-cart group discounts allocate pro-rata and reduce each taxed base", () => {
    // 90 + 30 = 120; group takes 12 total → allocated 9 + 3.
    const t = getCartTotalsWithTaxRules(
      [line(1, 90, 1), line(2, 30, 1)],
      null,
      new Map([
        [1, [rule(10, false)]],
        [2, [rule(10, false)]],
      ]),
      {
        cartAmounts: [{ refId: 9, amount: 12 }],
        lineAdjustments: [],
      },
    );
    // Bases 81 and 27 → tax 8.1 + 2.7 = 10.8.
    assert.equal(t.vat, 10.8);
    assert.equal(t.afterDiscount, 108);
    assert.equal(t.finalTotal, 118.8);
    assert.deepEqual(t.perLine[0]!.groupAdjustments, [{ refId: 9, amount: 9 }]);
    assert.deepEqual(t.perLine[1]!.groupAdjustments, [{ refId: 9, amount: 3 }]);
  });

  it("group amounts never push a line or the cart below zero", () => {
    const t = getCartTotals(
      [line(1, 50, 1)],
      null,
      0,
      {
        cartAmounts: [{ refId: 1, amount: 500 }],
        lineAdjustments: [{ refId: 2, amount: 500 }],
      },
    );
    assert.equal(t.groupCartAmount, 50); // clamped to the cart
    assert.equal(t.afterDiscount, 0);
    assert.equal(t.finalTotal, 0);
  });
});

describe("auto-applied promotion discounts (Phase 5)", () => {
  it("whole-cart promotion allocates pro-rata on the POST-GROUP line totals (legacy path)", () => {
    // Lines 100 + 300 = 400; group fixed 40 (pro-rata 10/30); promotion 10%
    // of the post-group 360 = 36 computed by the evaluator (amount passed
    // in); manual 10% bases on the post-group+promo 324 → 32.40.
    const t = getCartTotals(
      [line(1, 100, 1), line(2, 300, 1)],
      { type: "percentage", value: 10 },
      0,
      { cartAmounts: [{ refId: 7, amount: 40 }], lineAdjustments: [] },
      { cartAmounts: [{ refId: 11, amount: 36 }], lineAdjustments: [] },
    );
    assert.equal(t.groupCartAmount, 40);
    assert.equal(t.promoCartAmount, 36);
    // Promotion allocates on post-group totals 90/270 → 9/27.
    assert.deepEqual(t.promoLineAdjustments[0], [{ refId: 11, amount: 9 }]);
    assert.deepEqual(t.promoLineAdjustments[1], [{ refId: 11, amount: 27 }]);
    assert.equal(t.cartDiscountAmount, 32.4);
    assert.equal(t.afterDiscount, 400 - 40 - 36 - 32.4);
    assert.equal(t.finalTotal, 291.6);
  });

  it("line-scoped promotion amounts apply verbatim after the group layer (rules path)", () => {
    // Line 1: 100 (group scoped 10 → 90). Line 2: 200. Promotion scoped 15%
    // of line 1's post-group 90 = 13.50 (evaluator computed) → line 1 tax
    // base 76.50 at 10% exclusive.
    const t = getCartTotalsWithTaxRules(
      [line(1, 100, 1), line(2, 200, 1)],
      null,
      new Map([
        [1, [rule(10, false)]],
        [2, [rule(10, false)]],
      ]),
      { cartAmounts: [], lineAdjustments: [{ refId: 7, amount: 10 }, null] },
      { cartAmounts: [], lineAdjustments: [{ refId: 11, amount: 13.5 }, null] },
    );
    assert.equal(t.lineGroupTotal, 10);
    assert.equal(t.promoLineTotal, 13.5);
    assert.equal(t.perLine[0]!.taxAmount, 7.65);
    assert.equal(t.perLine[1]!.taxAmount, 20);
    assert.deepEqual(t.perLine[0]!.groupAdjustments, [{ refId: 7, amount: 10 }]);
    assert.deepEqual(t.perLine[0]!.promotionAdjustments, [{ refId: 11, amount: 13.5 }]);
    assert.deepEqual(t.perLine[1]!.promotionAdjustments, []);
    assert.equal(t.afterDiscount, 100 - 10 - 13.5 + 200);
    assert.equal(t.finalTotal, 276.5 + 27.65);
  });

  it("without promotion input every total is bit-for-bit the pre-promotions value", () => {
    const base = getCartTotals(
      [line(1, 100, 2), line(2, 50, 1)],
      { type: "fixed", value: 25 },
      15,
    );
    const withEmpty = getCartTotals(
      [line(1, 100, 2), line(2, 50, 1)],
      { type: "fixed", value: 25 },
      15,
      { cartAmounts: [], lineAdjustments: [] },
      { cartAmounts: [], lineAdjustments: [] },
    );
    assert.deepEqual(withEmpty, base);
  });

  it("promotion amounts never push a line or the cart below zero", () => {
    const t = getCartTotalsWithTaxRules(
      [line(1, 50, 1)],
      { type: "fixed", value: 30 },
      new Map([[1, [rule(10, false)]]]),
      { cartAmounts: [], lineAdjustments: [{ refId: 7, amount: 45 }] },
      { cartAmounts: [], lineAdjustments: [{ refId: 11, amount: 50 }] },
    );
    // Line: 50 − 45 group = 5 post-group; promo clamps to the engine base at
    // zero — nothing can go negative.
    assert.equal(t.afterDiscount, 0);
    assert.equal(t.finalTotal, 0);
  });
});
