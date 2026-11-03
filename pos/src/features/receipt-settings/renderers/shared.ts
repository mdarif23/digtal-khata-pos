/**
 * Helpers shared by the receipt and invoice HTML renderers. The renderer
 * output is a standalone HTML document (printed via hidden iframe and shown
 * in the live preview via srcDoc) — so every dynamic string MUST be escaped
 * and every value formatted deterministically here.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  BDT: "৳",
  USD: "$",
  EUR: "€",
  GBP: "£",
  INR: "₹",
  NPR: "रू",
  PKR: "₨",
  AED: "د.إ",
  SAR: "﷼",
};

export function currencySymbol(currency: string | null | undefined): string {
  if (!currency) return "৳";
  return CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency} `;
}

export function formatMoney(value: number | null | undefined, currency: string | null | undefined): string {
  const n = Number(value) || 0;
  return `${currencySymbol(currency)}${n.toLocaleString("en-BD", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDocumentDate(date: string | Date | null | undefined): string {
  const d = date ? new Date(date) : new Date();
  if (Number.isNaN(d.getTime())) {
    return new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  }
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

/** Escape untrusted text for interpolation into the print HTML. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escapes a data URL for use inside an HTML attribute. Data URLs are
 * base64 + a declared mime — the mime part is validated server-side, but
 * escape anyway so nothing can break out of the attribute.
 */
export function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}
