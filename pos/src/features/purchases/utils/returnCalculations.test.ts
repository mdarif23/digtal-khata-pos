import { describe, expect, it } from "vitest";
import {
  allocateScannedUnit,
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

describe("allocateScannedUnit (Phase 4: scans across sibling lines)", () => {
  const lines = [
    { id: 1, variantId: 10, receivedQuantity: 3, availableStock: 5 },
    { id: 2, variantId: 10, receivedQuantity: 4, availableStock: 5 },
    { id: 3, variantId: 20, receivedQuantity: 2, availableStock: 2 },
  ];

  it("fills the first line in purchase-order sequence", () => {
    expect(
      allocateScannedUnit({
        lines,
        variantId: 10,
        returnedByItem: new Map(),
        returnQuantities: {},
      }),
    ).toEqual({ 1: 1 });
  });

  it("moves to the next eligible line when the current is exhausted", () => {
    expect(
      allocateScannedUnit({
        lines,
        variantId: 10,
        returnedByItem: new Map(),
        returnQuantities: { 1: 3 }, // line 1 fully selected (received 3)
      }),
    ).toEqual({ 1: 3, 2: 1 });
  });

  it("returns null when every line of the variant is exhausted", () => {
    expect(
      allocateScannedUnit({
        lines,
        variantId: 10,
        returnedByItem: new Map(),
        returnQuantities: { 1: 3, 2: 4 },
      }),
    ).toBeNull();
  });

  it("caps allocation at the variant-wide shared stock", () => {
    const shared = [
      { id: 1, variantId: 10, receivedQuantity: 3, availableStock: 1 },
      { id: 2, variantId: 10, receivedQuantity: 3, availableStock: 1 },
    ];
    const first = allocateScannedUnit({
      lines: shared,
      variantId: 10,
      returnedByItem: new Map(),
      returnQuantities: {},
    });
    expect(first).toEqual({ 1: 1 });
    // The sibling line cannot take the unit — the shared stock is spent.
    expect(
      allocateScannedUnit({
        lines: shared,
        variantId: 10,
        returnedByItem: new Map(),
        returnQuantities: first!,
      }),
    ).toBeNull();
  });

  it("accounts for previously returned quantities", () => {
    expect(
      allocateScannedUnit({
        lines: [
          { id: 1, variantId: 10, receivedQuantity: 2, availableStock: 2 },
        ],
        variantId: 10,
        returnedByItem: new Map([[1, 2]]),
        returnQuantities: {},
      }),
    ).toBeNull();
  });

  it("returns null for a variant that is not on the purchase", () => {
    expect(
      allocateScannedUnit({
        lines,
        variantId: 99,
        returnedByItem: new Map(),
        returnQuantities: {},
      }),
    ).toBeNull();
  });

  it("keeps unrelated selections intact while allocating", () => {
    expect(
      allocateScannedUnit({
        lines,
        variantId: 10,
        returnedByItem: new Map(),
        returnQuantities: { 3: 2 },
      }),
    ).toEqual({ 1: 1, 3: 2 });
  });
});
