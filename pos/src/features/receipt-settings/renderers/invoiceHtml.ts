import type { SaleReceiptData } from "../../pos/types/receipt.types.js";
import type { DocumentBranding, InvoiceConfig } from "../schemas/documentSettings.schema.js";
import {
  escapeHtml,
  formatDocumentDate,
  formatMoney,
} from "./shared.js";

/**
 * THE invoice renderer — A4/A5 formal document, single source of truth for
 * preview and print (same contract as renderReceiptHtml).
 *
 * Presentation is controlled by `config`; every financial value comes from
 * the sale receipt data. Template changes never alter transaction amounts.
 */

export interface InvoiceRenderInput {
  receipt: SaleReceiptData;
  branding: DocumentBranding;
  config: InvoiceConfig;
  cashierName?: string | null;
}

export interface InvoiceHtml {
  html: string;
  paperWidthCss: string;
}

const PAPER_CSS: Record<"a4" | "a5", string> = {
  a4: "210mm",
  a5: "148mm",
};

export function renderInvoiceHtml(input: InvoiceRenderInput): InvoiceHtml {
  const { receipt, branding, config } = input;
  const v = config.visibility;
  const isA5 = config.paperSize === "a5";
  const paperWidthCss = PAPER_CSS[config.paperSize];

  const money = (n: number | null | undefined) => formatMoney(n, branding.currency);
  const esc = escapeHtml;

  // ---- header ---------------------------------------------------------
  const businessLines = [
    v.businessAddress && branding.address ? esc(branding.address) : "",
    v.businessPhone && branding.phone ? `Phone: ${esc(branding.phone)}` : "",
    v.businessEmail && branding.email ? esc(branding.email) : "",
    v.website && branding.website ? esc(branding.website) : "",
    v.vatBin && branding.vatBin ? `VAT/BIN: ${esc(branding.vatBin)}` : "",
  ].filter(Boolean);

  const header = `
    <table class="header-table">
      <tr>
        <td class="header-left">
          ${v.logo && branding.logoUrl ? `<img class="logo" src="${escapeHtml(branding.logoUrl)}" alt="" />` : ""}
          ${v.businessName ? `<div class="biz-name">${esc(branding.name)}</div>` : ""}
          ${branding.tagline ? `<div class="muted">${esc(branding.tagline)}</div>` : ""}
          ${businessLines.map((l) => `<div class="muted small">${l}</div>`).join("")}
        </td>
        <td class="header-right">
          <div class="doc-title">${esc(config.text.title)}</div>
          ${v.invoiceNumber ? `<div class="meta"><span class="muted">Invoice #:</span> <span class="bold">${esc(receipt.invoiceNumber)}</span></div>` : ""}
          ${v.invoiceDate ? `<div class="meta"><span class="muted">Date:</span> ${esc(formatDocumentDate(receipt.saleDate ?? receipt.createdAt))}</div>` : ""}
          ${v.paymentInfo ? `<div class="meta"><span class="muted">Status:</span> ${esc(receipt.paymentStatus.toUpperCase())}</div>` : ""}
        </td>
      </tr>
    </table>`;

  // ---- bill to --------------------------------------------------------
  const showCustomer = v.customerInfo || (v.customerAddress && receipt.customer?.address);
  const billTo = showCustomer
    ? `
    <div class="bill-to">
      <div class="muted small uppercase">Bill To</div>
      ${v.customerInfo ? `<div class="bold">${esc(receipt.customer?.name || "Walk-in Customer")}</div>` : ""}
      ${v.customerInfo && receipt.customer?.phone ? `<div class="small">${esc(receipt.customer.phone)}</div>` : ""}
      ${v.customerAddress && receipt.customer?.address ? `<div class="small">${esc(receipt.customer.address)}</div>` : ""}
    </div>`
    : "";

  // ---- items table ----------------------------------------------------
  interface Col {
    header: string;
    width: string;
    cls: string;
    cell: (item: SaleReceiptData["items"][number]) => string;
  }
  const cols: Col[] = [];
  if (v.itemDescription) {
    cols.push({
      header: "Description",
      width: "auto",
      cls: "text-left",
      cell: (item) => {
        const lines = [`<div class="bold">${esc(item.productName)}</div>`];
        if (item.variantName) lines.push(`<div class="muted small">${esc(item.variantName)}</div>`);
        return lines.join("");
      },
    });
  }
  if (v.itemSku) {
    cols.push({
      header: "SKU",
      width: "14%",
      cls: "text-left",
      cell: (item) => esc(item.sku ?? "—"),
    });
  }
  if (v.itemUnit) {
    cols.push({
      header: "Unit",
      width: "8%",
      cls: "text-center",
      cell: (item) => esc(item.unitName ?? "—"),
    });
  }
  if (v.quantity) {
    cols.push({
      header: "Qty",
      width: "8%",
      cls: "text-center",
      cell: (item) => String(item.quantity),
    });
  }
  if (v.unitPrice) {
    cols.push({
      header: "Unit Price",
      width: "14%",
      cls: "text-right",
      cell: (item) => money(item.unitPrice),
    });
  }
  if (v.lineDiscount) {
    cols.push({
      header: "Discount",
      width: "12%",
      cls: "text-right",
      cell: (item) => (item.discount > 0 ? `-${money(item.discount)}` : "—"),
    });
  }
  if (v.lineVat) {
    cols.push({
      header: "VAT",
      width: "10%",
      cls: "text-right",
      cell: (item) => (item.taxAmount > 0 ? money(item.taxAmount) : "—"),
    });
  }
  if (v.lineTotal) {
    cols.push({
      header: "Amount",
      width: "15%",
      cls: "text-right",
      cell: (item) => `<span class="bold">${money(item.lineTotal)}</span>`,
    });
  }

  const itemsTable = `
    <table class="items">
      <thead>
        <tr>
          ${cols.map((c) => `<th class="${c.cls}" style="width: ${c.width};">${c.header}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${receipt.items
          .map(
            (item) => `
          <tr>
            ${cols.map((c) => `<td class="${c.cls}">${c.cell(item)}</td>`).join("")}
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  // ---- totals ---------------------------------------------------------
  const totalsRows = [
    v.subtotal
      ? `<tr><td>Subtotal</td><td class="text-right">${money(receipt.subtotal)}</td></tr>`
      : "",
    v.overallDiscount && receipt.discount > 0
      ? `<tr><td>Discount</td><td class="text-right">-${money(receipt.discount)}</td></tr>`
      : "",
    v.vat && receipt.vat > 0
      ? `<tr><td>VAT / Tax</td><td class="text-right">${money(receipt.vat)}</td></tr>`
      : "",
    v.grandTotal
      ? `<tr class="grand"><td>Grand Total</td><td class="text-right">${money(receipt.finalTotal)}</td></tr>`
      : "",
    v.paidAmount
      ? `<tr><td>Paid</td><td class="text-right">${money(receipt.paidAmount)}</td></tr>`
      : "",
    v.dueAmount && receipt.dueAmount > 0
      ? `<tr class="due"><td>Amount Due</td><td class="text-right">${money(receipt.dueAmount)}</td></tr>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  const totals = totalsRows
    ? `<table class="totals">${totalsRows}</table>`
    : "";

  // ---- payments / note ------------------------------------------------
  const payments =
    v.paymentInfo && receipt.payments?.length
      ? `
    <div class="payments">
      <div class="muted small uppercase">Payment Information</div>
      ${receipt.payments
        .map(
          (p) => `
        <div class="small">${esc(p.method.replace("_", " "))}${p.reference ? ` — Ref: ${esc(p.reference)}` : ""}: <span class="bold">${money(p.amount)}</span></div>`,
        )
        .join("")}
    </div>`
      : "";

  const note =
    v.note && receipt.note
      ? `<div class="note"><span class="muted small uppercase">Note</span><div class="small">${esc(receipt.note)}</div></div>`
      : "";

  // ---- signature / terms / footer -------------------------------------
  const signature = config.showSignature
    ? `
    <div class="signature">
      <div class="sig-line"></div>
      <div class="muted small">Authorized Signature</div>
    </div>`
    : "";

  const terms = config.text.terms
    ? `
    <div class="terms">
      <div class="muted small uppercase">Terms & Conditions</div>
      <div class="small pre-wrap">${esc(config.text.terms)}</div>
    </div>`
    : "";

  const footer = config.text.footerMessage
    ? `<div class="doc-footer">${esc(config.text.footerMessage)}</div>`
    : "";

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Invoice - ${esc(receipt.invoiceNumber)}</title>
  <style>
    @page {
      size: ${config.paperSize} portrait;
      margin: ${isA5 ? "10mm" : "14mm"};
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      width: ${paperWidthCss};
      max-width: ${paperWidthCss};
      background: #fff;
      color: #111;
      font-family: Arial, Helvetica, sans-serif;
      font-size: ${isA5 ? "10.5px" : "12px"};
      line-height: 1.45;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .header-table { width: 100%; border-collapse: collapse; margin-bottom: ${isA5 ? "10px" : "18px"}; }
    .header-left { text-align: left; vertical-align: top; }
    .header-right { text-align: right; vertical-align: top; }
    .logo { max-width: ${isA5 ? "90px" : "130px"}; max-height: 56px; margin-bottom: 6px; }
    .biz-name { font-size: ${isA5 ? "14px" : "17px"}; font-weight: bold; }
    .doc-title { font-size: ${isA5 ? "20px" : "26px"}; font-weight: bold; letter-spacing: 2px; margin-bottom: 4px; }
    .muted { color: #555; }
    .small { font-size: 90%; }
    .bold { font-weight: bold; }
    .uppercase { text-transform: uppercase; letter-spacing: 0.5px; }
    .pre-wrap { white-space: pre-wrap; }
    .meta { margin-bottom: 2px; }
    .bill-to { margin: ${isA5 ? "8px" : "14px"} 0; padding: ${isA5 ? "8px" : "10px"} ${isA5 ? "10px" : "12px"}; background: #f7f7f7; border-radius: 6px; max-width: 55%; }
    table.items { width: 100%; border-collapse: collapse; margin-top: ${isA5 ? "8px" : "14px"}; }
    table.items th { border-bottom: 2px solid #111; padding: 6px 4px; font-size: 85%; text-transform: uppercase; letter-spacing: 0.5px; text-align: left; }
    table.items th.text-right { text-align: right; }
    table.items th.text-center { text-align: center; }
    table.items td { padding: ${isA5 ? "5px 4px" : "7px 4px"}; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
    table.totals { width: 45%; border-collapse: collapse; margin-top: ${isA5 ? "8px" : "12px"}; margin-left: auto; }
    table.totals td { padding: 4px 6px; }
    table.totals tr.grand td { border-top: 2px solid #111; border-bottom: 2px solid #111; font-weight: bold; font-size: ${isA5 ? "12px" : "14px"}; padding: 6px; }
    table.totals tr.due td { font-weight: bold; color: #b91c1c; }
    .payments { margin-top: ${isA5 ? "10px" : "16px"}; max-width: 55%; }
    .note { margin-top: ${isA5 ? "8px" : "12px"}; }
    .signature { margin-top: ${isA5 ? "18px" : "34px"}; width: 200px; text-align: center; }
    .sig-line { border-bottom: 1px solid #111; height: ${isA5 ? "24px" : "36px"}; }
    .terms { margin-top: ${isA5 ? "12px" : "20px"}; }
    .doc-footer { margin-top: ${isA5 ? "14px" : "24px"}; text-align: center; color: #555; font-size: 90%; border-top: 1px solid #e5e5e5; padding-top: 8px; }
    .footer-row { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
  </style>
</head>
<body>
  ${header}
  ${billTo}
  ${itemsTable}
  <div class="footer-row">
    <div>
      ${payments}
      ${note}
      ${terms}
    </div>
    <div>
      ${totals}
      ${signature}
    </div>
  </div>
  ${footer}
</body>
</html>`;

  return { html, paperWidthCss };
}
