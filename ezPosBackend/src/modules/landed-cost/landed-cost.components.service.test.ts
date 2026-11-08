import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyLandedCostComponents } from "./landed-cost.components.service.js";

const expense = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  expenseType: "freight",
  description: null,
  amount: 100,
  taxAmount: 0,
  taxTreatment: "none",
  isCapitalizable: true,
  sourceType: "additional_expense",
  sourceKey: null,
  ...overrides,
});

describe("classifyLandedCostComponents", () => {
  it("classifies the prompt's capitalization table", () => {
    const { components, totals } = classifyLandedCostComponents(
      { discount: 500, tax: 0, shippingCost: 300 },
      [
        expense({ id: 1, amount: 250, taxTreatment: "none" }), // freight
        expense({ id: 2, amount: 80, taxAmount: 12, taxTreatment: "recoverable" }),
        expense({ id: 3, amount: 60, taxAmount: 9, taxTreatment: "non_recoverable" }),
        expense({ id: 4, amount: 40, isCapitalizable: false }),
      ],
    );

    const byKey = new Map(components.map((c) => [c.sourceKey, c]));
    // Order discount REDUCES acquisition cost (negative, capitalized).
    assert.equal(byKey.get("order_discount")!.amount, -500);
    assert.equal(byKey.get("order_discount")!.inventoryTreatment, "capitalized");
    // Supplier shipping capitalized.
    assert.equal(byKey.get("shipping_cost")!.amount, 300);
    assert.equal(byKey.get("shipping_cost")!.inventoryTreatment, "capitalized");
    // Expense rows classify per their own treatment.
    assert.equal(byKey.get("expense:1")!.inventoryTreatment, "capitalized");
    assert.equal(byKey.get("expense:4")!.inventoryTreatment, "expensed");
    assert.equal(byKey.get("expense:4")!.capitalizationEligible, false);

    // Totals: capitalizable = −500 + 300 + 250 + 80 + 60 + 9(non-rec tax) = 199
    assert.equal(totals.capitalizable, 199);
    // Recoverable tax tracked separately, excluded from inventory.
    assert.equal(totals.recoverableTax, 12);
    // Non-capitalizable expensed.
    assert.equal(totals.expensed, 40);
  });

  it("keeps order tax excluded by default (legacy-preserving)", () => {
    const { components, totals } = classifyLandedCostComponents(
      { discount: 0, tax: 450, shippingCost: 0 },
      [],
    );
    assert.equal(components.length, 1);
    assert.equal(components[0]!.sourceKey, "order_tax");
    assert.equal(components[0]!.inventoryTreatment, "excluded");
    assert.equal(components[0]!.capitalizationEligible, false);
    assert.equal(totals.capitalizable, 0);
  });

  it("does not double-count the purchase-origin mirror row", () => {
    const { components } = classifyLandedCostComponents(
      { discount: 0, tax: 0, shippingCost: 300 },
      [
        // The Phase 4 auto row mirrors the header shipping — it must not
        // ALSO appear as an additional_expense component.
        expense({ id: 1, sourceType: "purchase", sourceKey: "shipping_cost", amount: 300 }),
        expense({ id: 2, amount: 100 }),
      ],
    );
    const keys = components.map((c) => c.sourceKey);
    assert.equal(keys.filter((k) => k === "shipping_cost").length, 1);
    assert.deepEqual(keys, ["shipping_cost", "expense:2"]);
  });

  it("handles a purchase with no components", () => {
    const { components, totals } = classifyLandedCostComponents(
      { discount: 0, tax: 0, shippingCost: 0 },
      [],
    );
    assert.equal(components.length, 0);
    assert.equal(totals.capitalizable, 0);
    assert.equal(totals.recoverableTax, 0);
    assert.equal(totals.expensed, 0);
  });
});
