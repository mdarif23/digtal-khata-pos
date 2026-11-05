import { describe, expect, it } from "vitest";
import {
  estimateReturnUnitPrice,
  maxReturnableQuantity,
} from "./returnCalculations";
import type { PurchasesItems } from "../purchase.types";

const line = (overrides: Partial<PurchasesItems> = {}): PurchasesItems =>
  ({
    id: 1,
    purchaseId: 1,
    variantId: 1,
    quantity: 10,
    receivedQuantity: 10,
    availableStock: 10,
    unitCost: 100,
    discount: 0,
    tax: 0,
    ...overrides,
  }) as PurchasesItems;

describe("maxReturnableQuantity", () => {
  it("caps at received minus already returned", () => {
    expect(
      maxReturnableQuantity({
        receivedQuantity: 10,
        alreadyReturned: 6,
        availableStock: 10,
        alreadySelectedForVariant: 0,
      }),
    ).toBe(4);
  });

  it("caps at on-hand stock minus sibling-line selections", () => {
    expect(
      maxReturnableQuantity({
        receivedQuantity: 10,
        alreadyReturned: 0,
        availableStock: 6,
        alreadySelectedForVariant: 2,
      }),
    ).toBe(4);
  });

  it("never goes below zero and floors fractional stock", () => {
    expect(
      maxReturnableQuantity({
        receivedQuantity: 2,
        alreadyReturned: 5,
        availableStock: 3,
        alreadySelectedForVariant: 0,
      }),
    ).toBe(0);
    expect(
      maxReturnableQuantity({
        receivedQuantity: 3,
        alreadyReturned: 0,
        availableStock: 2.5,
        alreadySelectedForVariant: 0,
      }),
    ).toBe(2);
  });
});

describe("estimateReturnUnitPrice", () => {
  it("amortizes line discount and tax over the ordered quantity", () => {
    expect(
      estimateReturnUnitPrice(line({ quantity: 10, unitCost: 100, discount: 50, tax: 20 })),
    ).toBe(97);
  });

  it("floors at zero for over-discounted lines", () => {
    // 10 × 100 − 1200 = −200 line total → −20/unit → floored to 0.
    expect(
      estimateReturnUnitPrice(line({ quantity: 10, unitCost: 100, discount: 1200 })),
    ).toBe(0);
  });
});
