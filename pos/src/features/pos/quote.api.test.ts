import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { quoteSaleApi } from "./quote.api.js";
import { quoteTotals, server } from "../../test/msw/server.js";

// The quote endpoint is the seam between the client's display math and the
// backend's authoritative totals — the cashier must see exactly what the
// sale will charge.

describe("quoteSaleApi", () => {
  it("returns the server-authoritative totals", async () => {
    const totals = await quoteSaleApi({
      items: [{ variantId: 11, quantity: 2, discount: null }],
      cartDiscount: { type: "fixed", value: 50 },
      vatPercent: null,
      customerId: null,
    });

    expect(totals.finalTotal).toBe(1050);
    expect(totals.usesTaxRules).toBe(true);
    expect(totals.perLine[0]?.taxAmount).toBe(100);
  });

  it("posts the payload the backend quote endpoint expects", async () => {
    let captured: unknown = null;
    server.use(
      http.post("*/api/sales/quote", async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ data: quoteTotals });
      }),
    );

    await quoteSaleApi({
      items: [{ variantId: 11, quantity: 3, discount: { type: "percentage", value: 10 } }],
      cartDiscount: null,
      vatPercent: null,
      couponCode: "SAVE10",
      customerId: 7,
    });

    expect(captured).toMatchObject({
      items: [
        { variantId: 11, quantity: 3, discount: { type: "percentage", value: 10 } },
      ],
      cartDiscount: null,
      vatPercent: null,
      couponCode: "SAVE10",
      customerId: 7,
    });
  });

  it("surfaces server errors — the fallback lives in the caller", async () => {
    server.use(
      http.post("*/api/sales/quote", () => HttpResponse.error()),
    );

    await expect(
      quoteSaleApi({
        items: [],
        cartDiscount: null,
        vatPercent: null,
      }),
    ).rejects.toThrow();
  });
});
