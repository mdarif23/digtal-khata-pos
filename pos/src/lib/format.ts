import { format as formatDateFns } from "date-fns";
import type { Locale } from "date-fns";
import { bn } from "date-fns/locale";

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

// ---- locale-aware dates (Phase 5 Bangla localization) ----------------------
// Additive only: an optional `locale` parameter on the date formatters,
// defaulting to a module-level active locale that the i18n language layer
// (setAppLanguage) keeps in sync. The default ("en") output is byte-identical
// to the pre-i18n behavior; money/quantity formatters stay Latin-digit
// deterministic (Bangla numerals are explicitly out of scope).
export type FormatLocale = "en" | "bn";

let activeFormatLocale: FormatLocale = "en";

/** Called by the i18n language layer on init and every language switch. */
export function setActiveFormatLocale(locale: FormatLocale): void {
  activeFormatLocale = locale;
}

/** date-fns options per FormatLocale — "en" stays undefined (current output). */
const LOCALE_OPTIONS: Record<FormatLocale, { locale: Locale } | undefined> = {
  en: undefined,
  bn: { locale: bn },
};

/** "14 Nov 2026" (en) / "15 জানু 2026" (bn); empty/invalid → "—". */
export function formatDate(
  value: string | Date | null | undefined,
  locale?: FormatLocale,
): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : formatDateFns(
        d,
        "dd MMM yyyy",
        LOCALE_OPTIONS[locale ?? activeFormatLocale],
      );
}

/** "14 Nov 2026, 03:25 PM" (en) / bn month names; empty/invalid → "—". */
export function formatDateTime(
  value: string | Date | null | undefined,
  locale?: FormatLocale,
): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : formatDateFns(
        d,
        "dd MMM yyyy, hh:mm a",
        LOCALE_OPTIONS[locale ?? activeFormatLocale],
      );
}
