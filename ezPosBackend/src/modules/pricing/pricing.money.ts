/**
 * Integer decimal helpers for the pricing engine (mirrors uom.money.ts /
 * utils/money.ts discipline). All pricing arithmetic runs on BigInt MICROS
 * (1 currency unit = 1,000,000 micros) so a 6-dp batch cost never crosses a
 * JS-float boundary; JS numbers appear only at the edges:
 *  - 2-dp money (prices, thresholds) → moneyToMicros
 *  - Postgres numeric strings (batch costs, up to 6 dp) → parseNumericToMicros
 *  - final rounded price → microsToMoney (exact 2-dp grid)
 *
 * Percentages are 3-dp (numeric(6,3) like tax_rates.rate) and travel as
 * integer MILLI-UNITS (1% = 1000; 33.333% = 33333).
 */

export const MICROS = 1_000_000n;
/** 100000 = 100% in milli-units. */
export const HUNDRED_PERCENT_MILLI = 100_000n;
export const MICROS_PER_POISHA = 10_000n;

export type RoundingIncrement = "none" | "0.01" | "1" | "5" | "10";
export type RoundingDirection = "nearest" | "up" | "down";

/** Micro-grid (in micros) of a rounding increment. 'none'/'0.01' = 1 poisha. */
export function roundingIncrementMicros(increment: RoundingIncrement): bigint {
  switch (increment) {
    case "1":
      return MICROS;
    case "5":
      return 5n * MICROS;
    case "10":
      return 10n * MICROS;
    case "none":
    case "0.01":
    default:
      return MICROS_PER_POISHA;
  }
}

/** 2-dp money number → exact micros (via integer poisha, never via floats). */
export function moneyToMicros(value: number): bigint {
  return BigInt(Math.round(value * 100)) * MICROS_PER_POISHA;
}

/** Integer micros → 2-dp money number. Value must already sit on the 2-dp grid. */
export function microsToMoney(micros: bigint): number {
  const poisha = micros / MICROS_PER_POISHA;
  if (micros % MICROS_PER_POISHA !== 0n) {
    throw new Error(
      `microsToMoney expects a 2-dp value, got ${micros} micros (sub-poisha residue)`,
    );
  }
  return Number(poisha) / 100;
}

/**
 * Postgres numeric literal (e.g. "123.456789", "0.1", "125") → exact micros.
 * Accepts up to 6 fractional digits; a 7th+ digit triggers half-up rounding
 * of the residue (batch costs are 6-dp, so this is defensive only).
 */
export function parseNumericToMicros(raw: string): bigint {
  const text = raw.trim();
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [intPartRaw, fracPartRaw = ""] = unsigned.split(".");
  const intPart = intPartRaw ?? "";
  const frac = fracPartRaw.replace(/[^0-9]/g, "");
  let intMicros = BigInt(intPart === "" ? "0" : intPart) * MICROS;
  let micros = intMicros;
  const first6 = frac.slice(0, 6).padEnd(6, "0");
  micros += BigInt(first6 === "" ? "0" : first6);
  if (frac.length > 6) {
    // Half-up on the truncated residue (≥ 5 in the 7th digit rounds up).
    if (BigInt(frac.slice(6)) * 2n >= 10n ** BigInt(frac.length - 6)) {
      micros += 1n;
    }
  }
  return negative ? -micros : micros;
}

/** 3-dp percent number → integer milli-units (30% → 30000). */
export function percentToMilliUnits(pct: number): bigint {
  return BigInt(Math.round(pct * 1000));
}

/** 2-dp percent number → integer milli-units (15.25% → 15250). */
export function moneyPercentToMilliUnits(pct: number): bigint {
  return BigInt(Math.round(pct * 1000));
}

/** Positive-domain integer division with half-up rounding. */
export function divRoundHalfUp(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error("divRoundHalfUp requires a positive divisor");
  const negative = num < 0n;
  const n = negative ? -num : num;
  let q = n / den;
  const r = n % den;
  if (r * 2n >= den) q += 1n;
  return negative ? -q : q;
}

/**
 * Final pricing stage (master prompt Part 10): round a computed price to the
 * configured grid exactly once — never during intermediate calculation.
 * 'nearest' is half-up (a remainder ≥ half the grid rounds up); 'up'/'down'
 * are ceiling/floor onto the grid. Inputs and outputs are micros; output is
 * always on the grid so microsToMoney stays exact.
 */
export function applyFinalRounding(
  priceMicros: bigint,
  increment: RoundingIncrement,
  direction: RoundingDirection,
): bigint {
  const grid = roundingIncrementMicros(increment);
  if (grid <= 0n) return priceMicros;
  const negative = priceMicros < 0n;
  const value = negative ? -priceMicros : priceMicros;
  let q = value / grid;
  const r = value % grid;
  let rounded = value;
  if (r === 0n) {
    rounded = value;
  } else if (direction === "down") {
    rounded = q * grid;
  } else if (direction === "up") {
    rounded = (q + 1n) * grid;
  } else {
    // nearest, half-up
    if (r * 2n >= grid) q += 1n;
    rounded = q * grid;
  }
  return negative ? -rounded : rounded;
}
