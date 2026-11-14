import { format as formatDateFns } from "date-fns";

/**
 * Canonical presentation formatters for the whole app.
 *
 * Money, quantities and dates previously had five competing implementations
 * (reports, purchases, due-management, receipt renderers) plus raw
 * `৳${n.toFixed(2)}` scattered over 70 files. Every display surface should
 * use these; modules migrate to them as their UI is touched.
 *
 * NOTE: these are display-only. They must never appear in API payloads —
 * the backend expects raw numbers.
 */

const MONEY = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const GROUPED = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** ৳1,234.50 — deterministic across ICU builds (never "BDT 1,234.50"). */
export function formatCurrency(value: number | string | null | undefined): string {
  const num = Number(value);
  return `৳${MONEY.format(Number.isFinite(num) ? num : 0)}`;
}

/** Grouped number with up to 2 decimals ("12,500" / "12.5"). */
export function formatNumber(value: number | string | null | undefined): string {
  const num = Number(value);
  return Number.isFinite(num) ? GROUPED.format(num) : "0";
}

/** Quantities: up to 3 decimals (weight lines), trailing zeros trimmed. */
export function formatQty(value: number | string | null | undefined): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  return String(Math.round(num * 1000) / 1000);
}

/** "14 Nov 2026"; empty/invalid → "—". */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : formatDateFns(d, "dd MMM yyyy");
}

/** "14 Nov 2026, 03:25 PM"; empty/invalid → "—". */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : formatDateFns(d, "dd MMM yyyy, hh:mm a");
}
