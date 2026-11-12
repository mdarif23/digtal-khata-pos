/**
 * THE warranty certificate renderer — a standalone, print-ready A4 HTML
 * document (same contract as receiptHtml.ts: printed via a hidden iframe
 * and previewable via <iframe srcDoc>, so preview and print cannot drift).
 *
 * Self-contained on purpose: its escape/date/duration helpers live here so
 * the certificate renders identically whether it is printed from the sale
 * success dialog, the warranty registry, or anywhere else.
 */

export interface WarrantyCertificateWarrantyRow {
  warrantyNumber: string;
  customerName: string | null;
  customerPhone?: string | null;
  productName: string;
  variantOptionLabel?: string | null;
  serialNumber?: string | null;
  provider: string;
  warrantyType?: string | null;
  duration: number;
  durationUnit: string;
  startDate: string | Date;
  expiryDate: string | Date;
  terms?: string | null;
  invoiceNumber?: string | null;
  status?: string | null;
  /** The rest of the backend detail row is carried but unused here. */
  [key: string]: unknown;
}

export interface WarrantyCertificateBranding {
  name: string;
  logoUrl: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  website: string | null;
  vatBin: string | null;
  tagline: string | null;
}

export interface WarrantyCertificatePayload {
  warranty: {
    warranty: WarrantyCertificateWarrantyRow;
    claims?: unknown[];
  };
  branding: WarrantyCertificateBranding;
}

export interface WarrantyCertificateHtml {
  html: string;
  paperWidthCss: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  manufacturer: "Manufacturer",
  seller: "Seller",
  distributor: "Distributor",
  supplier: "Supplier",
  third_party: "Third party",
};

const WARRANTY_TYPE_LABELS: Record<string, string> = {
  repair: "Repair",
  replacement: "Replacement",
  service: "Service",
  limited: "Limited",
  parts_only: "Parts only",
  comprehensive: "Comprehensive",
};

function humanizeEnum(
  value: string | null | undefined,
  labels: Record<string, string>,
): string {
  if (!value) return "—";
  return labels[value] ?? value.replace(/_/g, " ");
}

/** "12 Months" / "30 Days" / "2 Years". */
function formatDurationLabel(duration: number, durationUnit: string): string {
  const unit = durationUnit.charAt(0).toUpperCase() + durationUnit.slice(1);
  return `${duration} ${unit}`;
}

/** Date-only medium format ("11 Nov 2027") for validity dates. */
function formatDate(date: string | Date | null | undefined): string {
  if (!date) return "—";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { dateStyle: "medium" });
}

/** Escape untrusted text for interpolation into the print HTML. */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escAttr(value: unknown): string {
  return esc(value);
}

export function renderWarrantyCertificateHtml(
  payload: WarrantyCertificatePayload,
): WarrantyCertificateHtml {
  const paperWidthCss = "210mm";
  const w = payload.warranty.warranty;
  const branding = payload.branding;

  const contactLines = [
    branding.address ? esc(branding.address) : "",
    branding.phone ? `Phone: ${esc(branding.phone)}` : "",
    branding.email ? esc(branding.email) : "",
    branding.website ? esc(branding.website) : "",
    branding.vatBin ? `VAT/BIN: ${esc(branding.vatBin)}` : "",
  ].filter(Boolean);

  const detailRow = (label: string, value: string) => `
      <div class="detail">
        <div class="detail-label">${label}</div>
        <div class="detail-value">${value}</div>
      </div>`;

  const productLine = w.variantOptionLabel
    ? `${esc(w.productName)} <span class="variant">(${esc(w.variantOptionLabel)})</span>`
    : esc(w.productName);

  const details = `
    <div class="details-grid">
      ${detailRow("Customer", esc(w.customerName || "Walk-in Customer"))}
      ${w.customerPhone ? detailRow("Phone", esc(w.customerPhone)) : ""}
      ${detailRow("Product", productLine)}
      ${w.serialNumber ? detailRow("Serial Number", `<span class="mono">${esc(w.serialNumber)}</span>`) : ""}
      ${detailRow("Provider", esc(humanizeEnum(w.provider, PROVIDER_LABELS)))}
      ${detailRow("Coverage", esc(humanizeEnum(w.warrantyType, WARRANTY_TYPE_LABELS)))}
      ${detailRow("Duration", esc(formatDurationLabel(w.duration, w.durationUnit)))}
      ${detailRow("Valid From", esc(formatDate(w.startDate)))}
      ${detailRow("Valid Until", `<span class="bold">${esc(formatDate(w.expiryDate))}</span>`)}
      ${w.invoiceNumber ? detailRow("Sale Invoice", `<span class="mono">${esc(w.invoiceNumber)}</span>`) : ""}
    </div>`;

  const terms = w.terms
    ? `
    <div class="terms">
      <div class="section-title">Warranty Terms</div>
      <p class="pre-wrap">${esc(w.terms)}</p>
    </div>`
    : "";

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Warranty Certificate - ${esc(w.warrantyNumber)}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 14mm;
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
      font-size: 12px;
      line-height: 1.5;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .accent-bar { height: 6px; background: #0f766e; border-radius: 3px; margin-bottom: 18px; }
    .header-table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
    .header-left { text-align: left; vertical-align: top; }
    .header-right { text-align: right; vertical-align: top; }
    .logo { max-width: 130px; max-height: 56px; margin-bottom: 6px; }
    .biz-name { font-size: 17px; font-weight: bold; }
    .tagline { color: #555; font-size: 90%; }
    .contact { color: #555; font-size: 90%; margin-bottom: 1px; }
    .doc-title {
      text-align: center;
      font-size: 30px;
      font-weight: bold;
      letter-spacing: 6px;
      text-transform: uppercase;
      color: #0f766e;
      margin: 22px 0 4px;
    }
    .doc-subtitle { text-align: center; color: #555; letter-spacing: 1px; text-transform: uppercase; font-size: 85%; margin-bottom: 20px; }
    .warranty-band {
      border: 2px solid #0f766e;
      border-radius: 8px;
      background: #f0fdfa;
      padding: 14px 16px;
      text-align: center;
      margin-bottom: 22px;
    }
    .warranty-band .band-label { text-transform: uppercase; letter-spacing: 2px; font-size: 75%; color: #0f766e; margin-bottom: 4px; }
    .warranty-band .warranty-number { font-family: 'Courier New', Courier, monospace; font-size: 24px; font-weight: bold; letter-spacing: 2px; }
    .details-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px 24px;
      border: 1px solid #e5e5e5;
      border-radius: 8px;
      padding: 18px;
      margin-bottom: 22px;
    }
    .detail-label { text-transform: uppercase; letter-spacing: 0.5px; font-size: 75%; color: #555; margin-bottom: 2px; }
    .detail-value { font-size: 13px; }
    .variant { color: #555; font-size: 90%; }
    .mono { font-family: 'Courier New', Courier, monospace; }
    .bold { font-weight: bold; }
    .section-title { text-transform: uppercase; letter-spacing: 0.5px; font-size: 85%; color: #555; border-bottom: 1px solid #e5e5e5; padding-bottom: 4px; margin-bottom: 6px; }
    .terms { margin-bottom: 22px; }
    .terms p { margin: 0; }
    .pre-wrap { white-space: pre-wrap; }
    .claim-note { background: #f7f7f7; border-radius: 6px; padding: 12px 14px; font-size: 90%; color: #333; }
    .doc-footer {
      margin-top: 26px;
      text-align: center;
      color: #555;
      font-size: 90%;
      border-top: 1px solid #e5e5e5;
      padding-top: 10px;
    }
    .doc-footer .note { font-weight: bold; color: #111; margin-bottom: 3px; }
  </style>
</head>
<body>
  <div class="accent-bar"></div>
  <table class="header-table">
    <tr>
      <td class="header-left">
        ${branding.logoUrl ? `<img class="logo" src="${escAttr(branding.logoUrl)}" alt="" />` : ""}
        <div class="biz-name">${esc(branding.name)}</div>
        ${branding.tagline ? `<div class="tagline">${esc(branding.tagline)}</div>` : ""}
      </td>
      <td class="header-right">
        ${contactLines.map((line) => `<div class="contact">${line}</div>`).join("")}
      </td>
    </tr>
  </table>

  <div class="doc-title">Warranty Certificate</div>
  <div class="doc-subtitle">This certifies that the product below is covered by warranty</div>

  <div class="warranty-band">
    <div class="band-label">Warranty Number</div>
    <div class="warranty-number">${esc(w.warrantyNumber)}</div>
  </div>

  ${details}
  ${terms}

  <div class="claim-note">
    To make a warranty claim, present this certificate together with your
    original invoice at the issuing store. Coverage is provided by
    ${esc(humanizeEnum(w.provider, PROVIDER_LABELS).toLowerCase())} and is
    subject to the terms above.
  </div>

  <div class="doc-footer">
    <div class="note">Please present this certificate and your invoice for any warranty claim.</div>
    <div>Issued by ${esc(branding.name)}${w.invoiceNumber ? ` · Invoice ${esc(w.invoiceNumber)}` : ""}</div>
  </div>
</body>
</html>`;

  return { html, paperWidthCss };
}

/**
 * Writes the certificate into a hidden iframe and opens the print dialog —
 * the same approach as usePrintReceipt.ts's printHtmlInIframe, kept
 * self-contained so this module has no dependency on the POS hooks.
 */
export function printWarrantyCertificate(
  payload: WarrantyCertificatePayload,
  cleanupDelayMs = 1500,
): void {
  const { html } = renderWarrantyCertificateHtml(payload);

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
  frameDoc.write(html);
  frameDoc.close();

  setTimeout(() => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch (e) {
      console.error("Warranty certificate print error:", e);
    } finally {
      setTimeout(() => {
        if (document.body.contains(iframe)) {
          document.body.removeChild(iframe);
        }
      }, cleanupDelayMs);
    }
  }, 250);
}
