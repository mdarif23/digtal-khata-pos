import { describe, expect, it } from "vitest";
import {
  bundleSavings,
  cartQuantityByVariant,
  missingForBundle,
  quickAddBlocks,
  type PosBundle,
} from "./bundleCart";

/**
 * Bundle & Combo Phase 2 — POS bundle-cart math: cart quantities in base
 * units, per-component shortfall, savings display, and one-tap gating.
 * The engine re-prices everything at quote/checkout; these pin the UX
 * contract (what the cards show and what one-tap add will do).
 */

const schoolPack: PosBundle = {
  id: 7,
  name: "School Pack",
  rule: { bundlePrice: 299 },
  endsAt: null,
  components: [
    { variantId: 1, quantity: 5, productName: "Notebook", sku: "NB", sellingPrice: 50 },
    { variantId: 2, quantity: 3, productName: "Pen", sku: "PN", sellingPrice: 30 },
    { variantId: 3, quantity: 1, productName: "Eraser", sku: "ER", sellingPrice: 10 },
  ],
  normalTotal: 350, // 5×50 + 3×30 + 1×10
};

describe("cartQuantityByVariant", () => {
  it("sums cart quantities per variant, converting packaging lines", () => {
    const cart = [
      { variants: [{ id: 1 }], quantity: 2, conversionFactor: 1 },
      { variants: [{ id: 2 }], quantity: 1, conversionFactor: 1 },
      // A Box-of-12 line counts as 12 base units.
      { variants: [{ id: 2 }], quantity: 2, conversionFactor: 12 },
    ] as unknown as Parameters<typeof cartQuantityByVariant>[0];
    const map = cartQuantityByVariant(cart);
    expect(map.get(1)).toBe(2);
    expect(map.get(2)).toBe(25); // 1 + 2×12
    expect(map.has(3)).toBe(false);
  });
});

describe("missingForBundle", () => {
  it("reports only the short components", () => {
    const quantities = new Map([
      [1, 3],
      [2, 3],
    ]);
    expect(missingForBundle(schoolPack, quantities)).toEqual([
      { variantId: 1, name: "Notebook", missing: 2 },
      { variantId: 3, name: "Eraser", missing: 1 },
    ]);
  });

  it("returns empty when the cart already covers the bundle", () => {
    const quantities = new Map([
      [1, 5],
      [2, 3],
      [3, 1],
    ]);
    expect(missingForBundle(schoolPack, quantities)).toEqual([]);
  });
});

describe("bundleSavings", () => {
  it("uses the package price when configured", () => {
    expect(bundleSavings(schoolPack)).toBe(51);
  });

  it("falls back to the percent rule", () => {
    expect(
      bundleSavings({ ...schoolPack, rule: { discountPercent: 10 } }),
    ).toBeCloseTo(35);
  });

  it("returns null without a pricing rule", () => {
    expect(bundleSavings({ ...schoolPack, rule: {} })).toBeNull();
  });
});

describe("quickAddBlocks", () => {
  const catalog = new Map([
    [1, { name: "Notebook", trackingType: "none" }],
    [2, { name: "Pen", trackingType: "batch" }],
  ]);

  it("passes a bundle of plain and batch-tracked components", () => {
    expect(quickAddBlocks(schoolPack, catalog)).toEqual([
      { variantId: 3, name: "Eraser", reason: "not-in-catalog" },
    ]);
  });

  it("blocks serial-tracked components (serials need explicit selection)", () => {
    const withSerial = new Map(catalog).set(3, {
      name: "Phone",
      trackingType: "serial",
    });
    expect(quickAddBlocks(schoolPack, withSerial)).toEqual([
      { variantId: 3, name: "Phone", reason: "serial-tracked" },
    ]);
  });

  it("passes when every component resolves to a non-serial product", () => {
    const full = new Map(catalog).set(3, { name: "Eraser", trackingType: "none" });
    expect(quickAddBlocks(schoolPack, full)).toEqual([]);
  });
});
