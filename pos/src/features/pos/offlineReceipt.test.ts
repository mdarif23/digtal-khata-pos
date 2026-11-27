import { describe, expect, it } from "vitest";
import type { CartTotalsView } from "./components/pos/CartItems.js";
import type { CartType } from "./types/cart.types.js";
import type { CreateSalePayload } from "./schemas/cart.schema.js";
import {
  buildOfflineReceipt,
  offlineInvoiceNumber,
} from "./offlineReceipt.js";

// The offline slip must carry exactly what the cashier confirmed (the LOCAL
// totals fallback — no server quote offline) and must be unmistakably
// provisional: an OFF- reference instead of an invoice number, no per-line
// tax engine, no server-issued warranty lines.

const cart: CartType[] = [
  {
    id: 11,
    name: "Rice 5kg",
    quantity: 2,
    unitPrice: 500,
    discount: { type: "fixed", value: 100 },
    serialNumbers: [],
    variants: [
      {
        id: 77,
        sku: "RICE-5",
        barcode: null,
        sellingPrice: 500,
      } as CartType["variants"][number],
    ],
  } as unknown as CartType,
];

const totals: CartTotalsView = {
  itemsBase: 1000,
  itemDiscount: 100,
  itemsTotal: 900,
  cartDiscountAmount: 0,
  afterDiscount: 900,
  vatPercent: 0,
  vat: 0,
  charges: [],
  chargesTotal: 0,
  finalTotal: 900,
};

const payments: CreateSalePayload["payments"] = [
  { method: "cash", amount: 900, tendered: 1000 },
];

describe("buildOfflineReceipt", () => {
  it("builds a provisional OFF- receipt from the cart and local totals", () => {
    const receipt = buildOfflineReceipt({
      cart,
      totals,
      payments,
      clientSaleId: "3c60f3f6-a73d-4b96-9db7-40fab947e9e2",
      customer: null,
    });

    expect(receipt.invoiceNumber).toBe("OFF-3C60F3F6");
    expect(offlineInvoiceNumber("3c60f3f6-a73d-4b96-9db7-40fab947e9e2")).toBe(
      "OFF-3C60F3F6",
    );
    expect(receipt.saleId).toBe(0);
    expect(receipt.subtotal).toBe(1000);
    expect(receipt.discount).toBe(100);
    expect(receipt.finalTotal).toBe(900);
    expect(receipt.paidAmount).toBe(900);
    expect(receipt.dueAmount).toBe(0);
    expect(receipt.paymentStatus).toBe("paid");
    expect(receipt.items).toHaveLength(1);
    expect(receipt.items[0]).toMatchObject({
      productName: "Rice 5kg",
      variantId: 77,
      sku: "RICE-5",
      quantity: 2,
      unitPrice: 500,
      discount: 100,
      lineTotal: 900,
      taxAmount: 0,
    });
    expect(receipt.payments[0]).toMatchObject({
      method: "cash",
      amount: 900,
      tendered: 1000,
    });
  });

  it("marks a due sale partial/unpaid with the receivable", () => {
    const receipt = buildOfflineReceipt({
      cart,
      totals: { ...totals, finalTotal: 900 },
      payments: [{ method: "due", amount: 900, tendered: null }],
      clientSaleId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      customer: { id: 7, name: "Due Customer", phone: "017", address: null },
    });
    expect(receipt.paidAmount).toBe(0);
    expect(receipt.dueAmount).toBe(900);
    expect(receipt.paymentStatus).toBe("unpaid");
    expect(receipt.customer?.name).toBe("Due Customer");
  });
});
