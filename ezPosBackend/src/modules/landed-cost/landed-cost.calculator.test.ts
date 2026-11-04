import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LandedCostValidationError,
  calculateAllocation,
  type AllocationLineInput,
} from "./landed-cost.calculator.js";
import {
  amountToMicros,
  allocateByBasis,
  lineNetValueMicros,
  quantityToMillis,
  weightToKgQuads,
} from "./landed-cost.money.js";
import { capitalizableAmountMicros } from "./landed-cost.types.js";

function line(
  purchaseItemId: number,
  batches: { id: number; qty: number }[],
  overrides: Partial<AllocationLineInput> = {},
): AllocationLineInput {
  return {
    purchaseItemId,
    variantId: purchaseItemId * 10,
    unitCost: 100,
    discount: 0,
    batches: batches.map((b, i) => ({
      batchId: b.id,
      batchNumber: `B${b.id}`,
      quantityReceived: b.qty,
    })),
    ...overrides,
  };
}

const nearly = (a: number, b: number, eps = 1e-6) =>
  Math.abs(a - b) <= eps;

describe("landed-cost money helpers", () => {
  it("converts 2-dp amounts to micros exactly", () => {
    assert.equal(amountToMicros("400"), 400_000_000n);
    assert.equal(amountToMicros(0.07), 70_000n);
    assert.equal(amountToMicros("1299.99"), 1_299_990_000n);
  });

  it("converts quantities and normalizes weights", () => {
    assert.equal(quantityToMillis(2.5), 2500n);
    assert.equal(weightToKgQuads(2, "kg"), 20_000n);
    assert.equal(weightToKgQuads(500, "g"), 5_000n); // 0.5 kg
    assert.equal(weightToKgQuads(1, "lb"), 4_535n); // 0.45359237 → 4dp trunc
    assert.equal(weightToKgQuads(16, "oz"), 4_535n); // 1 lb in oz
  });

  it("computes line net value exactly (3dp × 2dp − 2dp)", () => {
    assert.equal(lineNetValueMicros(2500n, 1001n, 0n), 2500n * 1001n * 10n);
    // 2.5 × 100.10 − 12.34 = 250.25 − 12.34 = 237.91 → 237_910_000 micros
    assert.equal(lineNetValueMicros(2500n, 10010n, 1234n), 237_910_000n);
  });

  it("largest-remainder allocation reconciles exactly", () => {
    // 400 split over 3 equal bases → 133.333… → 134/133/133 micros-exact
    const shares = allocateByBasis(400_000_000n, [
      { key: "a", basisMicros: 1000n },
      { key: "b", basisMicros: 1000n },
      { key: "c", basisMicros: 1000n },
    ]);
    const sum = [...shares.values()].reduce((s, v) => s + v, 0n);
    assert.equal(sum, 400_000_000n);
    assert.equal(shares.get("a"), 133_333_334n); // first gets the residual
  });

  it("rejects zero basis", () => {
    assert.throws(() => allocateByBasis(100n, [{ key: "a", basisMicros: 0n }]));
  });
});

describe("landed-cost calculator: quantity", () => {
  it("allocates the §F worked example: ৳400 over 10+10 units", () => {
    const result = calculateAllocation({
      method: "quantity",
      total: 400,
      lines: [
        line(1, [{ id: 11, qty: 10 }]),
        line(2, [{ id: 22, qty: 10 }]),
      ],
    });
    assert.equal(result.allocatedTotal, 400);
    assert.deepEqual(
      result.lines.map((l) => l.batches[0]!.allocatedAmount),
      [200, 200],
    );
    assert.deepEqual(
      result.lines.map((l) => l.batches[0]!.allocatedPerUnit),
      [20, 20],
    );
  });

  it("keeps variant-level identity and splits across batches", () => {
    // Small: 10 units, Medium: 30, Big: 50 → 200/600/1000 of ৳2,000
    const result = calculateAllocation({
      method: "quantity",
      total: 2000,
      lines: [
        line(1, [{ id: 11, qty: 10 }]),
        line(2, [{ id: 22, qty: 30 }]),
        line(3, [{ id: 33, qty: 50 }]),
      ],
    });
    assert.equal(result.allocatedTotal, 2000);
    const [small, medium, big] = result.lines;
    // 10/30/50 of 90 total units -> exact quads with residual to largest
    assert.equal(small!.batches[0]!.allocatedAmount, 222.2222);
    assert.equal(medium!.batches[0]!.allocatedAmount, 666.6667);
    assert.equal(big!.batches[0]!.allocatedAmount, 1111.1111);
    assert.equal(
      result.allocatedTotal,
      small!.batches[0]!.allocatedAmount +
        medium!.batches[0]!.allocatedAmount +
        big!.batches[0]!.allocatedAmount,
    );
  });

  it("splits a multi-batch line by batch quantity with exact totals", () => {
    const result = calculateAllocation({
      method: "quantity",
      total: 100,
      lines: [line(1, [{ id: 11, qty: 3 }, { id: 12, qty: 1 }])],
    });
    const [b1, b2] = result.lines[0]!.batches;
    assert.equal(b1!.allocatedAmount, 75);
    assert.equal(b2!.allocatedAmount, 25);
    assert.equal(result.lines[0]!.lineAllocatedAmount, 100);
  });

  it("absorbs rounding residuals deterministically (৳400 over 3 lines)", () => {
    const result = calculateAllocation({
      method: "quantity",
      total: 400,
      lines: [
        line(1, [{ id: 11, qty: 1 }]),
        line(2, [{ id: 22, qty: 1 }]),
        line(3, [{ id: 33, qty: 1 }]),
      ],
    });
    const amounts = result.lines.map((l) => l.batches[0]!.allocatedAmount);
    // Equal bases: residual lands on the first line (deterministic order).
    assert.deepEqual(amounts, [133.3334, 133.3333, 133.3333]);
    assert.equal(result.allocatedTotal, 400);
  });
});

describe("landed-cost calculator: value", () => {
  it("allocates by discounted line value, not quantity", () => {
    // line A: 10 × 100 − 0 = 1000; line B: 10 × 300 − 100 = 2900
    const result = calculateAllocation({
      method: "value",
      total: 400,
      lines: [
        line(1, [{ id: 11, qty: 10 }], { unitCost: 100 }),
        line(2, [{ id: 22, qty: 10 }], { unitCost: 300, discount: 100 }),
      ],
    });
    // 1000/2900 of 400 -> 102.5641 / 297.4359 (exact at 4 dp)
    assert.equal(result.lines[0]!.lineAllocatedAmount, 102.5641);
    assert.equal(result.lines[1]!.lineAllocatedAmount, 297.4359);
    assert.equal(result.allocatedTotal, 400);
  });
});

describe("landed-cost calculator: weight", () => {
  it("uses variant weight and falls back to product default (normalized)", () => {
    const result = calculateAllocation({
      method: "weight",
      total: 300,
      lines: [
        line(1, [{ id: 11, qty: 2 }], { variantWeight: 2, variantWeightUnit: "kg" }),
        line(2, [{ id: 22, qty: 1 }], { productDefaultWeightKg: 2 }), // 2 kg
      ],
    });
    // total weight 2×2 + 2 = 6 kg → 100 / 200
    assert.equal(result.lines[0]!.lineAllocatedAmount, 200);
    assert.equal(result.lines[1]!.lineAllocatedAmount, 100);
    assert.ok(nearly(result.lines[0]!.batches[0]!.weightSnapshot!, 4));
  });

  it("rejects lines with no weight at all", () => {
    assert.throws(
      () =>
        calculateAllocation({
          method: "weight",
          total: 100,
          lines: [line(1, [{ id: 11, qty: 1 }])],
        }),
      (err: unknown) =>
        err instanceof LandedCostValidationError &&
        err.issues.some((i) => i.code === "missing_weight"),
    );
  });
});

describe("landed-cost calculator: manual", () => {
  it("accepts exact manual sums and splits per line by batch qty", () => {
    const result = calculateAllocation({
      method: "manual",
      total: 400,
      lines: [line(1, [{ id: 11, qty: 1 }, { id: 12, qty: 1 }]), line(2, [{ id: 22, qty: 1 }])],
      manualLines: [
        { purchaseItemId: 1, amount: 100 },
        { purchaseItemId: 2, amount: 300 },
      ],
    });
    assert.equal(result.lines[0]!.lineAllocatedAmount, 100);
    assert.equal(result.lines[0]!.batches[0]!.allocatedAmount, 50);
    assert.equal(result.lines[1]!.lineAllocatedAmount, 300);
  });

  it("rejects mismatched manual sums and missing lines", () => {
    assert.throws(
      () =>
        calculateAllocation({
          method: "manual",
          total: 400,
          lines: [line(1, [{ id: 11, qty: 1 }]), line(2, [{ id: 22, qty: 1 }])],
          manualLines: [{ purchaseItemId: 1, amount: 300 }],
        }),
      (err: unknown) =>
        err instanceof LandedCostValidationError &&
        err.issues.some((i) => i.code === "manual_mismatch") &&
        err.issues.some((i) => i.code === "incomplete_manual_allocation"),
    );
  });
});

describe("landed-cost calculator: validation", () => {
  it("rejects duplicate lines and batches", () => {
    assert.throws(
      () =>
        calculateAllocation({
          method: "quantity",
          total: 100,
          lines: [line(1, [{ id: 11, qty: 1 }, { id: 11, qty: 1 }])],
        }),
      (err: unknown) =>
        err instanceof LandedCostValidationError &&
        err.issues.some((i) => i.code === "duplicate_batch"),
    );
  });

  it("rejects negative expenses at the capitalizable-base layer", () => {
    // zod guards positivity at the API; the base helper ignores non-capitalizable rows
    const micros = capitalizableAmountMicros([
      { amount: 100, isCapitalizable: true },
      { amount: 50, isCapitalizable: false },
      { amount: 10, taxAmount: 2, taxTreatment: "non_recoverable" },
    ]);
    // 100 + (10 + 2) = 112 capitalizable
    assert.equal(micros, 112_000_000n);
  });
});
