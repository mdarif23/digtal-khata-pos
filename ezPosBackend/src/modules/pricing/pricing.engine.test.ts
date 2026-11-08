import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MICROS,
  applyFinalRounding,
  divRoundHalfUp,
  microsToMoney,
  moneyToMicros,
  parseNumericToMicros,
} from "./pricing.money.js";
import {
  computeRecommendedPrice,
  evaluateMinimumPrice,
  finalizeRecommendedPrice,
} from "./pricing.engine.js";

/**
 * The pricing engine's money truth (master prompt Part 18, Phase-1 subset).
 * Expectations are exact — BigInt math, never float comparison.
 */

function markup(pct: number) {
  return { method: "markup" as const, percentage: pct, fixedPrice: null };
}
function margin(pct: number) {
  return { method: "margin" as const, percentage: pct, fixedPrice: null };
}
function fixed(price: number) {
  return { method: "fixed" as const, percentage: null, fixedPrice: price };
}

function priceOf(
  config: Parameters<typeof computeRecommendedPrice>[0],
  cost: number | null,
): number {
  const result = computeRecommendedPrice(
    config,
    cost == null ? null : moneyToMicros(cost),
  );
  const statusNote = `status=${result.status} reason=${
    "reason" in result ? result.reason : ""
  }`;
  assert.equal(result.status, "ok", statusNote);
  const finalized = finalizeRecommendedPrice(result, "none", "nearest");
  assert.equal(finalized.status, "ok", statusNote);
  return (finalized as { status: "ok"; price: number }).price;
}

describe("pricing.money", () => {
  it("converts 2-dp money to micros exactly", () => {
    assert.equal(moneyToMicros(125), 125n * MICROS);
    assert.equal(moneyToMicros(0.01), 10_000n);
    assert.equal(moneyToMicros(130), 130n * MICROS);
  });

  it("parses Postgres numeric literals (≤ 6dp) exactly", () => {
    assert.equal(parseNumericToMicros("123.456789"), 123_456_789n);
    assert.equal(parseNumericToMicros("0.1"), 100_000n);
    assert.equal(parseNumericToMicros("125"), 125n * MICROS);
    assert.equal(parseNumericToMicros("-12.5"), -12n * MICROS + -500_000n);
    // 7th digit residue rounds half-up.
    assert.equal(parseNumericToMicros("0.0000005"), 1n);
    assert.equal(parseNumericToMicros("1.2345675"), 1_234_568n);
  });

  it("divRoundHalfUp rounds half away from zero", () => {
    assert.equal(divRoundHalfUp(5n, 2n), 3n);
    assert.equal(divRoundHalfUp(4n, 2n), 2n);
    assert.equal(divRoundHalfUp(7n, 3n), 2n); // 2.33 → 2
    assert.equal(divRoundHalfUp(8n, 3n), 3n); // 2.67 → 3
  });

  it("applyFinalRounding implements each increment × direction", () => {
    const m = moneyToMicros;
    // Boundary cases are built in micros directly: moneyToMicros(125.005)
    // cannot represent the half-poisha through a JS float.
    const halfBelow = 125n * MICROS + 5_000n; // 125.005
    const justBelow = 125n * MICROS + 4_000n; // 125.004
    const barelyAbove = 125n * MICROS + 1_000n; // 125.001
    const almostNext = 125n * MICROS + 9_000n; // 125.009
    // none/0.01 grid = 1 poisha
    assert.equal(applyFinalRounding(halfBelow, "none", "nearest"), m(125.01));
    assert.equal(applyFinalRounding(justBelow, "none", "nearest"), m(125.0));
    assert.equal(applyFinalRounding(barelyAbove, "none", "up"), m(125.01));
    assert.equal(applyFinalRounding(almostNext, "none", "down"), m(125.0));
    // nearest 1
    assert.equal(applyFinalRounding(m(124.6), "1", "nearest"), m(125));
    assert.equal(applyFinalRounding(m(124.4), "1", "nearest"), m(124));
    assert.equal(applyFinalRounding(m(124.01), "1", "up"), m(125));
    assert.equal(applyFinalRounding(m(124.99), "1", "down"), m(124));
    // nearest 5
    assert.equal(applyFinalRounding(m(123), "5", "nearest"), m(125));
    assert.equal(applyFinalRounding(m(122), "5", "nearest"), m(120));
    assert.equal(applyFinalRounding(m(121), "5", "up"), m(125));
    assert.equal(applyFinalRounding(m(124), "5", "down"), m(120));
    // nearest 10
    assert.equal(applyFinalRounding(m(116), "10", "nearest"), m(120));
    assert.equal(applyFinalRounding(m(114), "10", "nearest"), m(110));
    assert.equal(applyFinalRounding(m(111), "10", "up"), m(120));
    assert.equal(applyFinalRounding(m(119), "10", "down"), m(110));
    // already on grid stays put
    assert.equal(applyFinalRounding(m(125), "1", "nearest"), m(125));
  });
});

describe("pricing.engine — markup vs margin (master prompt §5.1/§5.2)", () => {
  it("markup 10% (case 1)", () => {
    assert.equal(priceOf(markup(10), 10), 11.0);
    assert.equal(priceOf(markup(10), 100), 110.0);
  });

  it("markup 20% (case 2)", () => {
    assert.equal(priceOf(markup(20), 100), 120.0);
  });

  it("markup 30% — the master prompt example cost 100 → 130 (case 3)", () => {
    assert.equal(priceOf(markup(30), 100), 130.0);
  });

  it("margin 20% — cost 100 → 125 (case 4)", () => {
    assert.equal(priceOf(margin(20), 100), 125.0);
  });

  it("margin 50% — cost 100 → 200 (case 5)", () => {
    assert.equal(priceOf(margin(50), 100), 200.0);
  });

  it("rejects margin ≥ 100% (case 6) — never divides by zero", () => {
    for (const pct of [100, 120]) {
      const result = computeRecommendedPrice(margin(pct), moneyToMicros(100));
      assert.equal(result.status, "invalid");
      assert.match(
        (result as { reason: string }).reason,
        /below 100%/,
      );
    }
  });

  it("margin 99.999% still computes (price = 100 ÷ 0.00001 = 10,000,000)", () => {
    const result = computeRecommendedPrice(margin(99.999), moneyToMicros(100));
    assert.equal(result.status, "ok");
    assert.equal(
      (result as { priceMicros: bigint }).priceMicros,
      10_000_000n * MICROS,
    );
  });

  it("fixed selling price (case 7) needs no cost", () => {
    assert.equal(priceOf(fixed(199.99), null), 199.99);
    assert.equal(priceOf(fixed(150), 42), 150.0);
  });

  it("markup and margin are DIFFERENT formulas (master prompt §5.2)", () => {
    assert.equal(priceOf(markup(25), 100), 125.0);
    assert.equal(priceOf(margin(25), 100), 133.33); // 100 / 0.75
    assert.equal(priceOf(margin(25), 90), 120.0);
  });

  it("0% markup/margin prices at cost", () => {
    assert.equal(priceOf(markup(0), 77.5), 77.5);
    assert.equal(priceOf(margin(0), 77.5), 77.5);
  });

  it("decimal precision — no float drift (case 20)", () => {
    // 0.1 × 1.1 = 0.11 exactly; float math would give 0.11000000000000001.
    assert.equal(priceOf(markup(10), 0.1), 0.11);
    // 19.99 × 1.3 = 25.987 → 25.99 on the poisha grid.
    assert.equal(priceOf(markup(30), 19.99), 25.99);
    // 6-dp batch cost via the numeric parser: 33.333333 × 1.1 = 36.6666663 → 36.67.
    const cost = parseNumericToMicros("33.333333");
    const result = computeRecommendedPrice(markup(10), cost);
    assert.equal(result.status, "ok");
    assert.equal(
      (result as { priceMicros: bigint }).priceMicros,
      divRoundHalfUp(cost * 110000n, 100000n),
    );
  });

  it("percentage method with no cost → explicit cost_unavailable, never zero (case 19)", () => {
    for (const config of [markup(30), margin(20)]) {
      const result = computeRecommendedPrice(config, null);
      assert.equal(result.status, "cost_unavailable");
    }
  });

  it("rejects negative percentage configuration", () => {
    const result = computeRecommendedPrice(markup(-5), moneyToMicros(100));
    assert.equal(result.status, "invalid");
  });

  it("finalizeRecommendedPrice applies rounding once at the final stage", () => {
    const raw = computeRecommendedPrice(markup(30), moneyToMicros(333.33));
    assert.equal(raw.status, "ok");
    const none = finalizeRecommendedPrice(raw, "none", "nearest");
    const nearestTen = finalizeRecommendedPrice(raw, "10", "nearest");
    const upTen = finalizeRecommendedPrice(raw, "10", "up");
    assert.equal((none as { price: number }).price, 433.33);
    assert.equal((nearestTen as { price: number }).price, 430.0);
    assert.equal((upTen as { price: number }).price, 440.0);
  });
});

describe("pricing.engine — minimum price protection (master prompt Part 11)", () => {
  it("flags below-minimum selling price (case 17)", () => {
    const result = evaluateMinimumPrice({
      price: 99,
      cost: 80,
      minSellingPrice: 100,
    });
    assert.equal(result.violated, true);
    assert.deepEqual(result.violations, ["minimum_price"]);
    assert.equal(result.profitMicros, moneyToMicros(19));
  });

  it("price exactly at the floor is allowed", () => {
    const result = evaluateMinimumPrice({
      price: 100,
      cost: 80,
      minSellingPrice: 100,
    });
    assert.equal(result.violated, false);
    assert.deepEqual(result.violations, []);
  });

  it("flags margin-floor violation (case 17/18)", () => {
    // 110 on 100 cost = 9.09% margin; floor 15%.
    const result = evaluateMinimumPrice({
      price: 110,
      cost: 100,
      minMarginPercent: 15,
    });
    assert.equal(result.violated, true);
    assert.deepEqual(result.violations, ["minimum_margin"]);
  });

  it("exact margin floor boundary passes", () => {
    const result = evaluateMinimumPrice({
      price: 125,
      cost: 100,
      minMarginPercent: 20,
    });
    assert.equal(result.violated, false);
  });

  it("never fabricates a cost — margin floor un-evaluable without one (case 19)", () => {
    const result = evaluateMinimumPrice({
      price: 50,
      cost: null,
      minMarginPercent: 15,
      minSellingPrice: null,
    });
    assert.equal(result.violated, false);
    assert.equal(result.profitMicros, null);
  });

  it("negative profit is detectable via the margin floor (case 18)", () => {
    const result = evaluateMinimumPrice({
      price: 110,
      cost: 120,
      minMarginPercent: 0,
    });
    assert.equal(result.violated, true);
    assert.deepEqual(result.violations, ["minimum_margin"]);
    assert.equal(result.profitMicros, moneyToMicros(-10));
  });

  it("both floors can fire together", () => {
    const result = evaluateMinimumPrice({
      price: 90,
      cost: 100,
      minSellingPrice: 95,
      minMarginPercent: 10,
    });
    assert.equal(result.violated, true);
    assert.deepEqual(result.violations, ["minimum_price", "minimum_margin"]);
  });
});
