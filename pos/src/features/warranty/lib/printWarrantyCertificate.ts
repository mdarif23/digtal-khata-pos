import type { WarrantyCertificateData } from "../types/warranty.types";
import { durationLabel } from "./warranty-format";

/**
 * Printable warranty certificate. The backend serves the full data
 * (warranty facts + branding) from GET /warranties/:id/certificate; this
 * renders a standalone A5-friendly document in a hidden iframe (the same
 * technique the receipt printer uses) so the printout never includes app
 * chrome.
 */

function escapeHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
}

function row(label: string, value: string): string {
  return `
    <tr>
      <th>${escapeHtml(label)}</th>
      <td>${escapeHtml(value)}</td>
    </tr>`;
}

export function buildCertificateHtml(data: WarrantyCertificateData): string {
  const { warranty, branding } = data;
  const w = warranty.warranty;
  const variant = w.variantOptionLabel
    ? `${w.productName} (${w.variantOptionLabel})`
    : w.productName;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Warranty Certificate ${escapeHtml(w.warrantyNumber)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Georgia, "Times New Roman", serif;
      color: #1e293b;
      padding: 40px;
    }
    .sheet {
      max-width: 720px;
      margin: 0 auto;
      border: 3px double #0f766e;
      border-radius: 12px;
      padding: 32px 40px;
    }
    .brand { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #0f766e; padding-bottom: 16px; }
    .brand img { width: 56px; height: 56px; object-fit: contain; }
    .brand-name { font-size: 22px; font-weight: 700; color: #0f172a; }
    .brand-meta { font-size: 12px; color: #475569; line-height: 1.5; }
    h1 { text-align: center; font-size: 20px; letter-spacing: 4px; text-transform: uppercase; color: #0f766e; margin: 24px 0 4px; }
    .tagline { text-align: center; font-size: 12px; font-style: italic; color: #64748b; margin-bottom: 20px; }
    .number { text-align: center; font-size: 14px; margin-bottom: 24px; }
    .number strong { font-family: "Courier New", monospace; font-size: 16px; letter-spacing: 1px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    th, td { padding: 7px 10px; font-size: 13px; text-align: left; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
    th { width: 38%; color: #475569; font-weight: 600; }
    .terms { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; font-size: 12px; color: #475569; margin-bottom: 20px; white-space: pre-wrap; }
    .terms-title { font-weight: 700; color: #0f172a; margin-bottom: 6px; text-transform: uppercase; font-size: 11px; letter-spacing: 2px; }
    .footer { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 32px; font-size: 11px; color: #64748b; }
    .signature { border-top: 1px solid #94a3b8; padding-top: 6px; width: 180px; text-align: center; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="brand">
      ${branding.logoUrl ? `<img src="${escapeHtml(branding.logoUrl)}" alt="" />` : ""}
      <div>
        <div class="brand-name">${escapeHtml(branding.name ?? "Warranty Certificate")}</div>
        <div class="brand-meta">
          ${[branding.address, branding.phone, branding.email, branding.website]
            .filter(Boolean)
            .map((part) => escapeHtml(part))
            .join(" &middot; ")}
          ${branding.vatBin ? `<br/>VAT/BIN: ${escapeHtml(branding.vatBin)}` : ""}
        </div>
      </div>
    </div>

    <h1>Warranty Certificate</h1>
    ${branding.tagline ? `<p class="tagline">${escapeHtml(branding.tagline)}</p>` : ""}
    <p class="number">Certificate No. <strong>${escapeHtml(w.warrantyNumber)}</strong></p>

    <table>
      ${row("Customer", `${w.customerName ?? "—"}${w.customerPhone ? ` (${w.customerPhone})` : ""}`)}
      ${row("Invoice", warranty.invoiceNumber ?? "—")}
      ${row("Product", variant)}
      ${row("Serial number", w.serialNumber ?? "—")}
      ${row("Coverage", `${durationLabel(w.duration, w.durationUnit)} — ${w.warrantyType}`)}
      ${row("Provider", w.provider ?? "Shop warranty")}
      ${row("Start date", formatDate(w.startDate))}
      ${row("Expiry date", formatDate(w.expiryDate))}
      ${row("Covered quantity", `${w.quantity}${w.returnedQuantity ? ` (returned: ${w.returnedQuantity})` : ""}`)}
      ${row("Issued by", w.locationName ?? "—")}
      ${row("Issued on", formatDate(w.createdAt))}
    </table>

    ${warranty.warranty.voidReason ? `<div class="terms"><div class="terms-title">Voided</div>${escapeHtml(warranty.warranty.voidReason)}</div>` : ""}

    <div class="footer">
      <div>
        This certificate covers the product against manufacturing defects for
        the stated coverage period from the start date. Present this
        certificate and the original invoice for any service claim.
      </div>
      <div class="signature">Authorised signature</div>
    </div>
  </div>
</body>
</html>`;
}

/** Writes the certificate into a hidden iframe and opens the print dialog. */
export function printWarrantyCertificate(data: WarrantyCertificateData): void {
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.visibility = "hidden";
  iframe.setAttribute("aria-hidden", "true");
  document.body.appendChild(iframe);

  const frameDoc = iframe.contentWindow?.document;
  if (!frameDoc) {
    document.body.removeChild(iframe);
    return;
  }

  frameDoc.open();
  frameDoc.write(buildCertificateHtml(data));
  frameDoc.close();

  setTimeout(() => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch (error) {
      console.error("Certificate print failed:", error);
    } finally {
      setTimeout(() => {
        if (document.body.contains(iframe)) {
          document.body.removeChild(iframe);
        }
      }, 1500);
    }
  }, 250);
}
