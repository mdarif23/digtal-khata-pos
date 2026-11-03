import { describe, expect, it, vi } from "vitest";

// jsdom has no canvas — stub QR generation to a fixed data URL so the
// renderer's QR branch is exercised deterministically.
vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(async () => "data:image/png;base64,FAKEQR"),
  },
}));

import {
  normalizeInvoiceConfig,
  normalizeReceiptConfig,
  type ReceiptConfig,
} from "../schemas/documentSettings.schema.js";
import { renderReceiptHtml } from "../renderers/receiptHtml.js";
import { renderInvoiceHtml } from "../renderers/invoiceHtml.js";
import { SAMPLE_BRANDING, SAMPLE_RECEIPT } from "../renderers/sampleData.js";
import { formatMoney } from "../renderers/shared.js";

const branding = { ...SAMPLE_BRANDING };

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

async function renderReceipt(config: DeepPartial<ReceiptConfig> = {}) {
  return renderReceiptHtml({
    receipt: SAMPLE_RECEIPT,
    branding,
    config: normalizeReceiptConfig(config),
  });
}

describe("receipt renderer", () => {
  it("renders the financial values from the transaction", async () => {
    const { html } = await renderReceipt();
    expect(html).toContain("৳1,320.00"); // final total
    expect(html).toContain("৳1,390.00"); // subtotal
    expect(html).toContain("INV-2026-SAMPLE");
    expect(html).toContain("Premium Basmati Rice");
  });

  it("hides fields whose visibility flags are off", async () => {
    const { html } = await renderReceipt({
      visibility: {
        vat: false,
        customerName: false,
        customerPhone: false,
        subtotal: false,
        sku: false,
        barcode: false,
        qrCode: false,
        cashierName: false,
      },
    });
    expect(html).not.toContain("VAT / Tax");
    expect(html).not.toContain("Sample Customer");
    expect(html).not.toContain("Subtotal:");
    expect(html).not.toContain("MILK-1L");
    expect(html).not.toContain("Cashier:");
    // Grand total stays — financial essentials default on.
    expect(html).toContain("FINAL PAYABLE");
  });

  it("shows optional fields when enabled", async () => {
    const { html } = await renderReceipt({
      visibility: { sku: true, barcode: true, qrCode: true, vatBin: true },
    });
    expect(html).toContain("SKU: MILK-1L");
    expect(html).toContain("Code: 885000000115");
    expect(html).toContain("VAT/BIN:");
    expect(html).toContain("data:image/png;base64,FAKEQR");
  });

  it("emits the selected paper width", async () => {
    const narrow = await renderReceipt({ paperWidth: "58mm" });
    expect(narrow.html).toContain("size: 58mm auto");
    expect(narrow.paperWidthCss).toBe("58mm");

    const wide = await renderReceipt({ paperWidth: "80mm" });
    expect(wide.html).toContain("size: 80mm auto");
    expect(wide.paperWidthCss).toBe("80mm");
  });

  it("respects layout options (compact table, alignment, no separators)", async () => {
    const compact = await renderReceipt({
      layout: {
        itemTableStyle: "compact",
        headerAlign: "left",
        showSeparators: false,
      },
    });
    expect(compact.html).toContain("item-block");
    // No divider ELEMENTS rendered (the stylesheet rule itself always exists).
    expect(compact.html.match(/class="divider"/g)?.length ?? 0).toBe(0);
    const detailed = await renderReceipt({
      layout: { itemTableStyle: "detailed" },
    });
    expect(detailed.html).toContain("<th");
  });

  it("duplicates the receipt for multiple copies with page breaks", async () => {
    const { html } = await renderReceipt({ print: { copies: 3 } });
    expect(html.match(/FINAL PAYABLE/g)?.length).toBe(3);
    // Markup occurrences only (the stylesheet rule spells it `.copy.copy-break`).
    expect(html.match(/class="copy copy-break"/g)?.length).toBe(2);
  });

  it("escapes untrusted text", async () => {
    const { html } = await renderReceiptHtml({
      receipt: {
        ...SAMPLE_RECEIPT,
        customer: { id: 0, name: '<script>alert("x")</script>', phone: null, address: null },
        items: [
          {
            ...SAMPLE_RECEIPT.items[0]!,
            productName: "</td><script>steal()</script>",
          },
        ],
      },
      branding,
      config: normalizeReceiptConfig({}),
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("invoice renderer", () => {
  it("renders an A4 invoice with financials from the transaction", () => {
    const { html, paperWidthCss } = renderInvoiceHtml({
      receipt: SAMPLE_RECEIPT,
      branding,
      config: normalizeInvoiceConfig({}),
    });
    expect(paperWidthCss).toBe("210mm");
    expect(html).toContain("INVOICE");
    expect(html).toContain("৳1,320.00");
    expect(html).toContain("Grand Total");
    expect(html).toContain("Authorized Signature");
    expect(html).toContain("Terms");
  });

  it("switches to A5 proportions", () => {
    const result = renderInvoiceHtml({
      receipt: SAMPLE_RECEIPT,
      branding,
      config: normalizeInvoiceConfig({ paperSize: "a5" }),
    });
    expect(result.paperWidthCss).toBe("148mm");
    expect(result.html).toContain("size: a5 portrait");
  });

  it("hides columns and blocks whose flags are off", () => {
    const { html } = renderInvoiceHtml({
      receipt: SAMPLE_RECEIPT,
      branding,
      config: normalizeInvoiceConfig({
        visibility: {
          itemSku: false,
          itemUnit: false,
          lineDiscount: false,
          overallDiscount: false,
          lineVat: false,
          paymentInfo: false,
          note: false,
        },
        showSignature: false,
        text: { terms: "" },
      }),
    });
    expect(html).not.toContain(">SKU<");
    expect(html).not.toContain(">Unit<");
    expect(html).not.toContain(">Discount<");
    expect(html).not.toContain("Payment Information");
    expect(html).not.toContain("Authorized Signature");
    expect(html).not.toContain("Terms & Conditions");
  });

  it("shows the due amount line for partially paid sales", () => {
    const { html } = renderInvoiceHtml({
      receipt: { ...SAMPLE_RECEIPT, dueAmount: 300, paidAmount: 1020 },
      branding,
      config: normalizeInvoiceConfig({}),
    });
    expect(html).toContain("Amount Due");
    expect(html).toContain("৳300.00");
  });
});

describe("config normalization", () => {
  it("fills defaults for missing groups and strips unknown keys", () => {
    const config = normalizeReceiptConfig({
      paperWidth: "58mm",
      bogusTopLevel: true,
      layout: { fontSize: 10, nonsense: "x" },
    });
    expect(config.paperWidth).toBe("58mm");
    expect(config.layout.fontSize).toBe(10);
    expect(config.layout.itemTableStyle).toBe("detailed"); // default
    expect(config.visibility.grandTotal).toBe(true); // default
    expect((config as Record<string, unknown>).bogusTopLevel).toBeUndefined();
    expect((config.layout as Record<string, unknown>).nonsense).toBeUndefined();
  });

  it("falls back to pristine defaults for corrupt configs", () => {
    const config = normalizeReceiptConfig({ paperWidth: 12345, visibility: "nope" });
    expect(config.paperWidth).toBe("80mm");
    expect(config.visibility.grandTotal).toBe(true);

    const invoice = normalizeInvoiceConfig({ paperSize: "banner" });
    expect(invoice.paperSize).toBe("a4");
  });

  it("formats money with the currency symbol map", () => {
    expect(formatMoney(1320, "BDT")).toBe("৳1,320.00");
    expect(formatMoney(10, "USD")).toBe("$10.00");
    expect(formatMoney(null, "BDT")).toBe("৳0.00");
  });
});
