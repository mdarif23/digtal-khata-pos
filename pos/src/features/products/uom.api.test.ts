import { describe, expect, it } from "vitest";
import {
  buildAddPackagingUnitPayload,
  buildUpdatePackagingUnitPayload,
} from "./uom.api.js";

/**
 * Units & Packaging payload builders — the coercion rules the backend
 * (ezPosBackend/src/modules/uom/uom.validation.ts) re-validates: factor > 0,
 * empty prices mean "unset" (null), and a locked row's PATCH payload omits
 * the factor entirely instead of triggering a guaranteed 409.
 */

const baseFormValues = {
  unitId: 7,
  contains: "12",
  isPurchaseEnabled: true,
  isSaleEnabled: true,
  isDefaultPurchase: false,
  isDefaultSale: false,
  salePrice: "",
  purchasePrice: "",
};

describe("buildAddPackagingUnitPayload", () => {
  it("coerces the factor and empty prices into the API contract", () => {
    expect(
      buildAddPackagingUnitPayload({
        ...baseFormValues,
        salePrice: "  145.50  ",
        purchasePrice: "",
      }),
    ).toEqual({
      unitId: 7,
      conversionFactor: 12,
      isPurchaseEnabled: true,
      isSaleEnabled: true,
      isDefaultPurchase: false,
      isDefaultSale: false,
      salePrice: 145.5,
      purchasePrice: null,
    });
  });

  it("accepts fractional factors (1 Dozen = 0.5 of some base)", () => {
    const payload = buildAddPackagingUnitPayload({
      ...baseFormValues,
      contains: "0.5",
    });
    expect(payload.conversionFactor).toBe(0.5);
  });

  it("rejects zero, negative, and non-numeric factors", () => {
    for (const contains of ["0", "-3", "", "abc"]) {
      expect(() =>
        buildAddPackagingUnitPayload({ ...baseFormValues, contains }),
      ).toThrowError(/greater than zero/);
    }
  });

  it("rejects negative prices", () => {
    expect(() =>
      buildAddPackagingUnitPayload({ ...baseFormValues, salePrice: "-1" }),
    ).toThrowError(/Prices must be zero or a positive number/);
  });
});

describe("buildUpdatePackagingUnitPayload", () => {
  it("omits conversionFactor entirely when the row is locked", () => {
    const payload = buildUpdatePackagingUnitPayload(baseFormValues, {
      includeFactor: false,
    });
    expect(Object.prototype.hasOwnProperty.call(payload, "conversionFactor")).toBe(
      false,
    );
    expect(payload).toEqual({
      isPurchaseEnabled: true,
      isSaleEnabled: true,
      isDefaultPurchase: false,
      isDefaultSale: false,
      salePrice: null,
      purchasePrice: null,
    });
  });

  it("includes the factor when the row is not locked", () => {
    const payload = buildUpdatePackagingUnitPayload(
      { ...baseFormValues, contains: " 24 " },
      { includeFactor: true },
    );
    expect(payload.conversionFactor).toBe(24);
  });

  it("still validates the factor when it is included", () => {
    expect(() =>
      buildUpdatePackagingUnitPayload(
        { ...baseFormValues, contains: "0" },
        { includeFactor: true },
      ),
    ).toThrowError(/greater than zero/);
  });

  it("never carries a unitId (the PATCH contract cannot re-unit a row)", () => {
    const payload = buildUpdatePackagingUnitPayload(baseFormValues, {
      includeFactor: true,
    });
    expect(Object.prototype.hasOwnProperty.call(payload, "unitId")).toBe(false);
  });
});
