import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  amountToMicros,
  assertWholeBaseQuantity,
  baseToEnteredQuantity,
  divideMicrosHalfUp,
  enteredToBaseMicros,
  factorToMicros,
  floorDivAvailable,
  microsToNumber,
  perBasePriceMicros,
  quantityToMillis,
} from "./uom.money.js";

/**
 * Pure decimal-safe math for UOM conversion (no DB). These invariants back
 * every purchase/sale conversion, so they are pinned exactly:
 *  - 5 Box × 12 = 60 base (master-prompt §6A)
 *  - ৳1,200/box ÷ 12 = ৳100.000000/pc; ৳1,000 ÷ 3 = ৳333.333333 (6-dp grid)
 *  - 2.5 Box of a 1.5 factor is NOT a whole base quantity (INTEGER stock)
 */
describe("uom.money conversion math", () => {
  it("converts entered quantities to base micros exactly", () => {
    const f12 = factorToMicros(12);
    assert.equal(enteredToBaseMicros(5, f12), 60_000_000n);
    assert.equal(enteredToBaseMicros(0.001, f12), 12_000n);
    assert.equal(enteredToBaseMicros("2.5", factorToMicros(2)), 5_000_000n);
  });

  it("derives per-base prices at the 6-dp grid with half-up rounding", () => {
    assert.equal(perBasePriceMicros(1200, factorToMicros(12)), 100_000_000n);
    // 1000 / 3 = 333.333333… → 333.333333 (half-up at the 6-dp grid)
    assert.equal(perBasePriceMicros(1000, factorToMicros(3)), 333_333_333n);
    // 0.01 / 7 = 0.00142857… → 0.001429
    assert.equal(perBasePriceMicros(0.01, factorToMicros(7)), 1_429n);
    // exact division stays exact
    assert.equal(perBasePriceMicros(1500, factorToMicros(12)), 125_000_000n);
  });

  it("enforces whole base quantities for stock-affecting flows", () => {
    assert.doesNotThrow(() => assertWholeBaseQuantity(18_000_000n, "Piece"));
    assert.throws(
      () => assertWholeBaseQuantity(2_500_000n, "Piece"),
      /whole number of Piece/,
    );
  });

  it("round-trips base → entered quantity at the 3-dp entered grid", () => {
    const f12 = factorToMicros(12);
    assert.equal(baseToEnteredQuantity(60, f12), 5);
    assert.equal(baseToEnteredQuantity(13, f12), 1.083); // 13/12 = 1.083333 → 1.083
  });

  it("floors available packages for POS availability", () => {
    assert.equal(floorDivAvailable(48, factorToMicros(12)), 4);
    assert.equal(floorDivAvailable(47, factorToMicros(12)), 3);
    assert.equal(floorDivAvailable(0, factorToMicros(12)), 0);
  });

  it("rounds half-up on micro division for positive and negative values", () => {
    assert.equal(divideMicrosHalfUp(5n, 2n), 3n); // 2.5 → 3
    assert.equal(divideMicrosHalfUp(3n, 2n), 2n); // 1.5 → 2
    assert.equal(divideMicrosHalfUp(-5n, 2n), -3n);
    assert.throws(() => divideMicrosHalfUp(1n, 0n));
  });

  it("keeps storage-scale conversions exact", () => {
    assert.equal(quantityToMillis(12.345), 12345n);
    assert.equal(amountToMicros(1234.56), 1_234_560_000n);
    assert.equal(microsToNumber(333_333_333n), 333.333333);
  });
});
