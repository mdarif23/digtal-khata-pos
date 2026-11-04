import { http, HttpResponse } from "msw";
import type { QuoteTotals } from "@/features/pos/quote.api.js";

/**
 * Default MSW handlers for component/hook tests. Suites override per-test
 * with server.use(...). Unhandled requests are BYPASSED in the global setup
 * so existing tests that mock axios directly stay unaffected.
 */

export const quoteTotals: QuoteTotals = {
  itemsBase: 1000,
  itemDiscount: 0,
  itemsTotal: 1000,
  cartDiscountAmount: 50,
  afterDiscount: 950,
  vatPercent: 0,
  vat: 100,
  finalTotal: 1050,
  usesTaxRules: true,
  perLine: [
    {
      variantId: 11,
      taxAmount: 100,
      detail: [
        {
          taxRateId: 1,
          name: "VAT 10%",
          rate: 10,
          isInclusive: false,
          amount: 100,
        },
      ],
    },
  ],
};

export const handlers = [
  http.post("*/api/sales/quote", async () => {
    return HttpResponse.json({ data: quoteTotals });
  }),
];
