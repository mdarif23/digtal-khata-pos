import { describe, expect, it } from "vitest";
import { outstandingOf, overReceiveOf } from "./receiveQuantities";
import type { PurchasesItems } from "../purchase.types";

const line = (overrides: Partial<PurchasesItems> = {}): PurchasesItems =>
  ({
    id: 1,
    purchaseId: 1,
    variantId: 1,
    quantity: 10,
    receivedQuantity: 0,
    cancelledQuantity: 0,
    deliveredQuantity: 0,
    rejectedQuantity: 0,
    ...overrides,
  }) as PurchasesItems;

describe("outstandingOf", () => {
  it("is ordered minus received minus cancelled", () => {
    expect(
      outstandingOf(line({ quantity: 10, receivedQuantity: 8, cancelledQuantity: 0 })),
    ).toBe(2);
    expect(
      outstandingOf(line({ quantity: 10, receivedQuantity: 8, cancelledQuantity: 2 })),
    ).toBe(0);
  });

  it("never goes negative", () => {
    expect(
      outstandingOf(line({ quantity: 5, receivedQuantity: 8 })),
    ).toBe(0);
  });
});

describe("overReceiveOf", () => {
  it("flags acceptances beyond the outstanding quantity", () => {
    expect(overReceiveOf(line({ quantity: 10, receivedQuantity: 8 }), 3)).toEqual({
      overQuantity: 1,
    });
  });

  it("returns null within the outstanding remainder", () => {
    expect(overReceiveOf(line({ quantity: 10, receivedQuantity: 8 }), 2)).toBeNull();
  });

  it("counts cancelled quantities as written off (receiving them is over-receiving)", () => {
    expect(
      overReceiveOf(
        line({ quantity: 10, receivedQuantity: 8, cancelledQuantity: 2 }),
        1,
      ),
    ).toEqual({ overQuantity: 1 });
  });
});
