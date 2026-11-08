/**
 * Money helpers for the Finance & Growth ledger.
 *
 * Strategy (approved architecture §7.6): ledger columns are numeric(14,2)
 * mapped as strings — money never crosses a JS-float boundary on the
 * financial spine. Amounts arriving at the service edge (zod-validated
 * numbers) are converted to integer POISHA (1 taka = 100 poisha) for
 * comparison/arithmetic and serialized back with toMoneyString().
 *
 * This mirrors the integer-poisha convention already used by sale payment
 * validation (src/modules/sales/sales.validation.ts).
 */

/** Round a 2dp-intended JS number to integer poisha (half-up). */
export function toPoisha(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100);
}

/** Integer poisha → canonical numeric-literal string for numeric(14,2). */
export function poishaToMoneyString(poisha: number): string {
  const sign = poisha < 0 ? "-" : "";
  const abs = Math.abs(poisha);
  const taka = Math.floor(abs / 100);
  const paisa = abs % 100;
  return `${sign}${taka}.${String(paisa).padStart(2, "0")}`;
}

/** 2dp JS number → canonical numeric-literal string. */
export function toMoneyString(amount: number): string {
  return poishaToMoneyString(toPoisha(amount));
}

/**
 * Assert an amount is a finite, non-negative value expressible in 2dp.
 * Rejects NaN/Infinity and amounts with sub-poisha residue introduced by
 * float math (tolerance of half a poisha after rounding).
 */
export function assertMoneyAmount(amount: number, label: string): number {
  if (!Number.isFinite(amount)) {
    throw new Error(`${label} must be a finite number, got ${amount}`);
  }
  if (amount < 0) {
    throw new Error(`${label} must be non-negative, got ${amount}`);
  }
  const residue = Math.abs(amount * 100 - toPoisha(amount));
  if (residue > 0.01) {
    throw new Error(
      `${label} has more than 2 decimal places of precision: ${amount}`,
    );
  }
  return toPoisha(amount);
}

/**
 * Business-local calendar date (YYYY-MM-DD) for ledger entry dates and
 * period assignment. The server may run UTC; accounting dates follow the
 * business timezone (businesses.timezone, default Asia/Dhaka).
 */
export function businessLocalDate(
  at: Date,
  timezone: string,
): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    // Invalid stored timezone — fail safe to server-local date.
    return at.toISOString().slice(0, 10);
  }
}
