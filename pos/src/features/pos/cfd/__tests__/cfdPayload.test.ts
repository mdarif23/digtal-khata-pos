import { describe, expect, it } from "vitest";
import { buildCfdCartPayload, buildCfdPaidPayload } from "../cfdPayload.js";
import type { CartTotalsView } from "../../components/pos/CartItems.js";

// P0 fix #4: the customer-facing display used to hardcode discountTotal: 0
// and vatTotal: 0 and compute the grand total before cart discounts and VAT.
// These tests pin the composition against the shared totals view.

const baseTotals: CartTotalsView = {
  itemsBase: 1000,
  itemDiscount: 0,
  itemsTotal: 1000,
  cartDiscountAmount: 0,
  afterDiscount: 1000,
  vatPercent: 0,
  vat: 0,
  finalTotal: 1000,
};

describe("buildCfdCartPayload", () => {
  it("shows cart discount and VAT that used to be hardcoded to zero", () => {
    const payload = buildCfdCartPayload(
      [
        {
          name: "Rice 5kg",
          quantity: 2,
          unitPrice: 500,
          discount: null,
        },
      ],
      {
        ...baseTotals,
        itemDiscount: 100,
        itemsTotal: 900,
        cartDiscountAmount: 50,
        afterDiscount: 850,
        vatPercent: 5,
        vat: 42.5,
        finalTotal: 892.5,
      },
    );
    expect(payload.status).toBe("cart");
    expect(payload.discountTotal).toBe(150); // line + cart discounts
    expect(payload.vatTotal).toBe(42.5);
    expect(payload.grandTotal).toBe(892.5);
    expect(payload.items[0]).toMatchObject({
      name: "Rice 5kg",
      quantity: 2,
      unitPrice: 500,
      lineTotal: 1000,
    });
  });

  it("aggregates group pricing, promotions and coupon discounts", () => {
    const payload = buildCfdCartPayload(
      [{ name: "Tea", quantity: 1, unitPrice: 400, discount: null }],
      {
        ...baseTotals,
        itemsBase: 400,
        itemDiscount: 0,
        itemsTotal: 400,
        cartDiscountAmount: 0,
        group: { id: 1, name: "Wholesale", discountAmount: 40 },
        promotions: {
          applied: [{ id: 7, name: "Weekend deal", amount: 20 }],
          total: 20,
        },
        coupon: { code: "SAVE10", discountAmount: 34, description: null },
        afterDiscount: 306,
        vat: 0,
        finalTotal: 306,
      },
    );
    expect(payload.discountTotal).toBe(94); // 40 group + 20 promo + 34 coupon
    expect(payload.grandTotal).toBe(306);
  });

  it("keeps price overrides and honors an empty cart as idle", () => {
    const overridden = buildCfdCartPayload(
      [
        {
          name: "Dented can",
          quantity: 1,
          unitPrice: 120,
          priceOverride: { unitPrice: 90 },
          discount: null,
        },
      ],
      { ...baseTotals, finalTotal: 90, afterDiscount: 90, itemsBase: 120 },
    );
    expect(overridden.items[0]?.unitPrice).toBe(90);
    expect(overridden.items[0]?.lineTotal).toBe(90);

    const empty = buildCfdCartPayload([], baseTotals);
    expect(empty.status).toBe("idle");
    expect(empty.items).toEqual([]);
  });
});

describe("buildCfdPaidPayload", () => {
  it("uses the receipt's authoritative numbers after payment", () => {
    const payload = buildCfdPaidPayload(
      [
        {
          productName: "Rice 5kg",
          variantName: null,
          quantity: 2,
          unitPrice: 500,
          lineTotal: 1000,
        },
      ],
      {
        discount: 50,
        vat: 42.5,
        finalTotal: 892.5,
        paidAmount: 800,
        dueAmount: 92.5,
      },
    );
    expect(payload.status).toBe("paid");
    expect(payload.grandTotal).toBe(892.5);
    expect(payload.paidTotal).toBe(800);
    expect(payload.dueTotal).toBe(92.5);
    expect(payload.discountTotal).toBe(50);
    expect(payload.vatTotal).toBe(42.5);
  });
});
