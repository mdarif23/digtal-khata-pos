/** Shared price-math helpers for the Smart Procurement pages. */

export type PriceDirection = "up" | "down" | "flat";

/**
 * Percentage change from `previous` to `current`, rounded to 2 decimals.
 * Returns null when the change is not computable (missing values, or a
 * zero previous price — a percentage from zero is meaningless).
 */
export function percentChange(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | null {
  if (
    current === null ||
    current === undefined ||
    previous === null ||
    previous === undefined ||
    previous === 0
  ) {
    return null;
  }
  return Number((((current - previous) / previous) * 100).toFixed(2));
}

/** "+12.50%" / "−4.00%" / "—" formatter for percentage changes. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

export function priceDirection(
  value: number | null | undefined,
): PriceDirection {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) {
    return "flat";
  }
  return value > 0 ? "up" : "down";
}

/**
 * Per-unit comparison price for a quotation: a ৳1,500 quote for a 25 KG
 * sack normalizes to ৳60/KG. Returns null when the quote is already per
 * unit (no package size) so callers can distinguish the two.
 */
export function perUnitPrice(
  quotedPrice: number | null | undefined,
  packageQuantity: number | null | undefined,
): number | null {
  if (
    quotedPrice === null ||
    quotedPrice === undefined ||
    !Number.isFinite(quotedPrice) ||
    packageQuantity === null ||
    packageQuantity === undefined ||
    !Number.isFinite(packageQuantity) ||
    packageQuantity <= 0
  ) {
    return null;
  }
  return Number((quotedPrice / packageQuantity).toFixed(2));
}
