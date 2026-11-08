import QRCode from "qrcode";
import type { SaleReceiptData } from "../../pos/types/receipt.types.js";
import type { DocumentBranding, ReceiptConfig } from "../schemas/documentSettings.schema.js";
import {
  escapeAttr,
  escapeHtml,
  formatDocumentDate,
  formatMoney,
} from "./shared.js";

/**
 * THE receipt renderer — single source of truth for what a receipt looks
 * like. The live preview and the actual print both consume this function's
 * standalone HTML (preview in an <iframe srcDoc>, print via the hidden
 * print iframe), so they cannot drift apart.
 *
 * Presentation is controlled entirely by `config`; every financial value
 * comes from the sale receipt data (snapshotted at transaction time) — a
 * template change can never alter amounts.
 */

export interface ReceiptRenderInput {
  receipt: SaleReceiptData;
  branding: DocumentBranding;
  config: ReceiptConfig;
  /** Overrides receipt.cashierName when provided (e.g. logged-in user). */
  cashierName?: string | null;
  /** Defaults to config.print.copies; the live preview passes 1. */
  copies?: number;
}

export interface ReceiptHtml {
  html: string;
  /** CSS width of the paper (e.g. "58mm") for preview sizing. */
  paperWidthCss: string;
}

const PAPER_WIDTH_CSS: Record<"58mm" | "80mm", string> = {
  "58mm": "58mm",
  "80mm": "80mm",
};

export async function renderReceiptHtml(input: ReceiptRenderInput): Promise<ReceiptHtml> {
  const { receipt, branding, config } = input;
  const v = config.visibility;
  const layout = config.layout;
  const text = config.text;
  const is58 = config.paperWidth === "58mm";
  const paperWidthCss = PAPER_WIDTH_CSS[config.paperWidth];

  const money = (n: number | null | undefined) => formatMoney(n, branding.currency);
  const esc = escapeHtml;

  let qrDataUrl: string | null = null;
  if (v.qrCode) {
    try {
      qrDataUrl = await QRCode.toDataURL(
        `INV:${receipt.invoiceNumber}|TOTAL:${receipt.finalTotal.toFixed(2)}`,
        { margin: 0, width: is58 ? 96 : 128 },
      );
    } catch {
      qrDataUrl = null;
    }
  }

  const sep = layout.showSeparators ? `<div class="divider"></div>` : "";

  // ---- header -------------------------------------------------------
  const header = `
    <div class="header" style="text-align: ${layout.headerAlign};">
      ${v.logo && branding.logoUrl ? `<img class="logo" src="${escapeAttr(branding.logoUrl)}" alt="" />` : ""}
      ${v.businessName ? `<div class="shop-name">${esc(branding.name)}</div>` : ""}
      ${branding.tagline ? `<div class="sub">${esc(branding.tagline)}</div>` : ""}
      ${v.businessAddress && branding.address ? `<div class="sub">${esc(branding.address)}</div>` : ""}
      ${v.businessPhone && branding.phone ? `<div class="sub">Phone: ${esc(branding.phone)}</div>` : ""}
      ${v.businessEmail && branding.email ? `<div class="sub">${esc(branding.email)}</div>` : ""}
      ${v.vatBin && branding.vatBin ? `<div class="sub">VAT/BIN: ${esc(branding.vatBin)}</div>` : ""}
    </div>`;

  // ---- meta rows ----------------------------------------------------
  const cashierName = input.cashierName ?? receipt.cashierName ?? null;
  const meta = `
    ${v.invoiceNumber ? `<div class="row"><span>Invoice:</span><span class="bold">${esc(receipt.invoiceNumber)}</span></div>` : ""}
    ${v.dateTime ? `<div class="row"><span>Date:</span><span>${esc(formatDocumentDate(receipt.saleDate ?? receipt.createdAt))}</span></div>` : ""}
    ${v.cashierName && cashierName ? `<div class="row"><span>Cashier:</span><span>${esc(cashierName)}</span></div>` : ""}`;

  // ---- customer -----------------------------------------------------
  const customerName = receipt.customer?.name || "Walk-in Customer";
  const customer = v.customerName || (v.customerPhone && receipt.customer?.phone)
    ? `
    ${sep}
    ${v.customerName ? `<div class="row"><span>Customer:</span><span class="bold">${esc(customerName)}</span></div>` : ""}
    ${v.customerPhone && receipt.customer?.phone ? `<div class="row"><span>Phone:</span><span>${esc(receipt.customer.phone)}</span></div>` : ""}`
    : "";

  // ---- items --------------------------------------------------------
  const showQtyCol = v.quantity;
  const showPriceCol = v.unitPrice;
  const showTotalCol = v.lineTotal;
  const compact = layout.itemTableStyle === "compact";

  const itemSubLines = (item: SaleReceiptData["items"][number]): string => {
    const parts: string[] = [];
    if (item.variantName) parts.push(esc(item.variantName));
    if (v.sku && item.sku) parts.push(`SKU: ${esc(item.sku)}`);
    if (v.barcode && item.barcode) parts.push(`Code: ${esc(item.barcode)}`);
    if (v.lineDiscount && item.discount > 0) parts.push(`Disc: -${money(item.discount)}`);
    return parts.map((p) => `<div class="sub">${p}</div>`).join("");
  };

  // UOM (migration 0062): a line sold in a packaging unit shows the entered
  // unit ("1 Box") with the base equivalent ("= 12 pcs"); base lines are
  // unchanged.
  const qtyDisplay = (item: SaleReceiptData["items"][number]): string => {
    if (item.enteredUnitAbbreviation && item.enteredQuantity != null) {
      const base = item.quantity;
      return `${item.enteredQuantity} ${item.enteredUnitAbbreviation} (= ${base} ${item.unitName ?? ""})`.replace(/\s+/g, " ").trim();
    }
    return String(item.quantity);
  };

  const itemLine = (item: SaleReceiptData["items"][number]): string => {
    if (compact) {
      const qtyPart = showQtyCol ? `${qtyDisplay(item)} ${showPriceCol ? `x ${money(item.enteredUnitPrice ?? item.unitPrice)}` : ""}` : "";
      const totalPart = showTotalCol ? money(item.lineTotal) : "";
      return `
      <div class="item-block">
        <div class="item-title">${v.productName ? esc(item.productName) : ""}</div>
        ${itemSubLines(item)}
        ${qtyPart || totalPart ? `<div class="row"><span>${esc(qtyPart)}</span><span class="bold">${esc(totalPart)}</span></div>` : ""}
      </div>`;
    }
    return `
      <tr>
        <td>
          ${v.productName ? `<div class="item-title">${esc(item.productName)}</div>` : ""}
          ${itemSubLines(item)}
        </td>
        ${showQtyCol ? `<td class="text-center">${esc(qtyDisplay(item))}</td>` : ""}
        ${showPriceCol ? `<td class="text-right">${money(item.enteredUnitPrice ?? item.unitPrice)}</td>` : ""}
        ${showTotalCol ? `<td class="text-right bold">${money(item.lineTotal)}</td>` : ""}
      </tr>`;
  };

  const itemsHtml = compact
    ? receipt.items.map(itemLine).join("")
    : `
    <table>
      <thead>
        <tr>
          <th class="text-left">Item</th>
          ${showQtyCol ? `<th class="text-center" style="width: 25px;">Qty</th>` : ""}
          ${showPriceCol ? `<th class="text-right" style="width: 45px;">Price</th>` : ""}
          ${showTotalCol ? `<th class="text-right" style="width: 50px;">Total</th>` : ""}
        </tr>
      </thead>
      <tbody>
        ${receipt.items.map(itemLine).join("")}
      </tbody>
    </table>`;

  // ---- totals -------------------------------------------------------
  const totals = `
    ${v.subtotal ? `<div class="row"><span>Subtotal:</span><span>${money(receipt.subtotal)}</span></div>` : ""}
    ${v.overallDiscount && receipt.discount > 0 ? `<div class="row"><span>Discount:</span><span>-${money(receipt.discount)}</span></div>` : ""}
    ${v.vat && receipt.vat > 0 ? `<div class="row"><span>VAT / Tax:</span><span>+${money(receipt.vat)}</span></div>` : ""}
    ${v.grandTotal ? `<div class="total-row"><span>FINAL PAYABLE:</span><span>${money(receipt.finalTotal)}</span></div>` : ""}`;

  // ---- payments -----------------------------------------------------
  const showPayments = v.paymentMethod || v.paidAmount || v.dueAmount || v.changeAmount;
  const methodRows =
    v.paymentMethod && receipt.payments?.length
      ? receipt.payments
          .map(
            (p) => `
      <div class="row">
        <span>${esc(p.method.replace("_", " "))}${p.reference ? ` (${esc(p.reference)})` : ""}:</span>
        <span class="bold">${money(p.amount)}</span>
      </div>`,
          )
          .join("")
      : v.paidAmount
        ? `<div class="row"><span>Paid:</span><span class="bold">${money(receipt.paidAmount)}</span></div>`
        : "";

  const tenderedRows =
    v.paidAmount && receipt.payments?.some((p) => p.method === "cash" && p.tendered)
      ? receipt.payments
          .filter((p) => p.method === "cash" && p.tendered)
          .map(
            (p) => `
        <div class="row subtle"><span>Cash Tendered:</span><span>${money(p.tendered)}</span></div>`,
          )
          .join("")
      : "";

  const changeRow =
    v.changeAmount && receipt.change > 0
      ? `<div class="row bold"><span>Change Returned:</span><span>${money(receipt.change)}</span></div>`
      : "";
  const dueRow =
    v.dueAmount && receipt.dueAmount > 0
      ? `<div class="row due-alert"><span>OUTSTANDING DUE:</span><span>${money(receipt.dueAmount)}</span></div>`
      : receipt.dueAmount <= 0 && v.dueAmount
        ? `<div class="text-center bold paid-full">*** PAID IN FULL ***</div>`
        : "";

  const paymentsHtml = showPayments
    ? `
    <div class="payments-box">
      ${methodRows}
      ${tenderedRows}
      ${changeRow}
      ${dueRow}
    </div>`
    : "";

  // ---- footer -------------------------------------------------------
  const footer = `
    ${sep}
    <div class="footer" style="padding-top: ${layout.footerSpacingPx}px;">
      ${text.thankYouMessage ? `<div class="footer-note bold">${esc(text.thankYouMessage)}</div>` : ""}
      ${text.footerMessage ? `<div class="footer-note">${esc(text.footerMessage)}</div>` : ""}
      ${text.additionalMessage ? `<div class="footer-note">${esc(text.additionalMessage)}</div>` : ""}
      ${qrDataUrl ? `<img class="qr" src="${escapeAttr(qrDataUrl)}" alt="QR" />` : ""}
    </div>`;

  const receiptBody = `
    ${header}
    ${sep}
    ${text.title ? `<div class="doc-title">${esc(text.title)}</div>` : ""}
    ${meta}
    ${customer}
    ${sep}
    ${itemsHtml}
    ${sep}
    ${totals}
    ${paymentsHtml}
    ${footer}`;

  const copies = Math.max(1, input.copies ?? config.print.copies);
  const body =
    copies > 1
      ? Array.from({ length: copies })
          .map(
            (_, i) =>
              `<div class="copy${i < copies - 1 ? " copy-break" : ""}">${receiptBody}</div>`,
          )
          .join("")
      : receiptBody;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Receipt - ${esc(receipt.invoiceNumber)}</title>
  <style>
    @page {
      size: ${paperWidthCss} auto;
      margin: ${layout.marginMm}mm;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      width: ${paperWidthCss};
      max-width: ${paperWidthCss};
      background: #fff;
      color: #000;
      font-family: 'Courier New', Courier, monospace;
      font-size: ${layout.fontSize}px;
      line-height: 1.25;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .copy.copy-break { page-break-after: always; }
    .header { padding-bottom: ${layout.headerSpacingPx}px; }
    .logo { max-width: ${layout.logoWidthPx}px; max-height: ${Math.round(layout.logoWidthPx * 0.6)}px; margin-bottom: 4px; }
    .shop-name { font-weight: bold; text-transform: uppercase; font-size: ${layout.fontSize + 3}px; }
    .doc-title { text-align: ${layout.headerAlign}; font-weight: bold; text-transform: uppercase; margin-bottom: 3px; font-size: ${layout.fontSize + 1}px; }
    .sub { font-size: 85%; color: #333; }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .text-left { text-align: left; }
    .bold { font-weight: bold; }
    .divider { border-top: 1px dashed #000; margin: 4px 0; }
    .row { display: flex; justify-content: space-between; align-items: flex-start; gap: 6px; margin-bottom: 2px; }
    .row span:last-child { text-align: right; }
    table { width: 100%; border-collapse: collapse; margin: 4px 0; }
    th { border-bottom: 1px solid #000; padding: 3px 1px; font-size: 85%; text-transform: uppercase; }
    td { padding: 3px 1px; vertical-align: top; border-bottom: 1px dotted #ccc; }
    .item-title { font-weight: bold; }
    .item-block { margin-bottom: 6px; }
    .subtle { font-size: 85%; color: #444; }
    .total-row {
      font-size: ${layout.fontSize + 1}px;
      font-weight: bold;
      display: flex;
      justify-content: space-between;
      border-top: 1px solid #000;
      border-bottom: 1px solid #000;
      padding: 4px 0;
      margin: 4px 0;
    }
    .payments-box { background: #f9f9f9; border: 1px solid #ddd; padding: 4px; margin: 4px 0; }
    .due-alert { font-weight: bold; border-top: 1px dashed #000; padding-top: 3px; margin-top: 3px; }
    .paid-full { font-size: 80%; margin-top: 3px; }
    .footer-note { font-size: 85%; margin-top: 4px; line-height: 1.2; }
    .qr { display: block; margin: 6px auto 0; width: ${is58 ? 72 : 88}px; height: ${is58 ? 72 : 88}px; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;

  return { html, paperWidthCss };
}
