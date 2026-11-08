/**
 * Decimal-safe UOM conversion math.
 *
 * Same discipline as landed-cost.money.ts: NO JavaScript floating-point
 * arithmetic produces an authoritative quantity or price. Everything
 * travels as BigInt at the natural storage scale:
 *
 *   entered quantity numeric(12,3) → millis  = round(q × 1000)
 *   conversion factor numeric(14,6) → micros = round(f × 10⁶)
 *   base quantity   → micros = millis × factorMicros / 1000 (exact integer
 *   division only when the result is representable; stock-affecting flows
 *   additionally require a WHOLE base quantity because every stock, batch,
 *   transfer, count and movement column is INTEGER).
 *   prices numeric(14,2) → cents → micros; per-base price = micros ÷ factor
 *   micros with deterministic half-up rounding at the 6-dp storage grid.
 */

export const MICROS = 1_000_000n;
export const MILLIS = 1_000n;

/**
 * Thrown when factor × entered quantity is not a whole base quantity for a
 * stock-affecting flow (INTEGER stock invariant). Services map it to a 400.
 */
export class UomWholeQuantityError extends Error {}

/** numeric(14,6) factor → BigInt micros (exact for any 6-dp input). */
export function factorToMicros(factor: number | string): bigint {
  return BigInt(Math.round(Number(factor) * 1e6));
}

/** numeric(12,3) quantity → BigInt millis (exact). */
export function quantityToMillis(quantity: number | string): bigint {
  return BigInt(Math.round(Number(quantity) * 1000));
}

/** numeric(14,2) money → BigInt micros (exact via cents). */
export function amountToMicros(amount: number | string): bigint {
  return BigInt(Math.round(Number(amount) * 100)) * 10_000n;
}

/** BigInt micros → number at the 6-dp storage grid. */
export function microsToNumber(micros: bigint): number {
  return Number(micros) / 1e6;
}

/** Half-up division of BigInt micros by a positive BigInt divisor. */
export function divideMicrosHalfUp(numerator: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new Error("divideMicrosHalfUp: non-positive divisor");
  if (numerator >= 0n) return (numerator * 2n + divisor) / (divisor * 2n);
  return -((-numerator * 2n + divisor) / (divisor * 2n));
}

export interface BaseConversion {
  /** Base quantity as a number on the 6-dp grid (exact when whole). */
  baseQuantity: number;
  /** Exact base quantity in micros. */
  baseMicros: bigint;
}

/**
 * entered × factor → base quantity (micros-exact).
 * entered millis × factor micros / MILLIS — exact whenever the product is
 * representable on the 6-dp grid (it always is for whole factors).
 */
export function enteredToBaseMicros(
  enteredQuantity: number | string,
  factorMicros: bigint,
): bigint {
  if (factorMicros <= 0n) throw new Error("Invalid conversion factor");
  return (quantityToMillis(enteredQuantity) * factorMicros) / MILLIS;
}

/**
 * The INTEGER-stock invariant: factor × entered quantity must be a whole
 * number for any stock-affecting flow. Throws with an operator-readable
 * message otherwise (e.g. "2.5 Box of 1.5 does not convert to a whole
 * number of Pieces — adjust the quantity or the conversion factor").
 */
export function assertWholeBaseQuantity(
  baseMicros: bigint,
  baseUnitLabel: string,
): void {
  if (baseMicros % MICROS !== 0n) {
    throw new UomWholeQuantityError(
      `The entered quantity does not convert to a whole number of ${baseUnitLabel}. ` +
        `Stock is tracked in whole ${baseUnitLabel}.`,
    );
  }
}

/**
 * Per-base-unit price from an entered-unit price, in MICROS, half-up at the
 * 6-dp grid. (৳1,500 / 12 → 125.000000; ৳1,000 / 3 → 333.333333.) Line
 * money is always computed from the ENTERED values, so this derivation
 * never moves a stored total.
 *
 * Scale check: amountMicros × MICROS ÷ factorMicros — the extra MICROS
 * factor converts the dimensionless ratio back onto the price micros grid.
 */
export function perBasePriceMicros(
  enteredUnitPrice: number | string,
  factorMicros: bigint,
): bigint {
  return divideMicrosHalfUp(amountToMicros(enteredUnitPrice) * MICROS, factorMicros);
}

/**
 * Base → entered-unit quantity (for displays and return eligibility),
 * half-up at the 3-dp entered grid (numeric(12,3)).
 */
export function baseToEnteredQuantity(
  baseQuantity: number,
  factorMicros: bigint,
): number {
  const baseMicros = BigInt(Math.round(baseQuantity * 1e6));
  const enteredMillis = divideMicrosHalfUp(baseMicros * MILLIS, factorMicros);
  return Number(enteredMillis) / 1e3;
}

/**
 * How many whole entered units fit in the available base quantity
 * (POS availability: floor(48 pcs / 12) = 4 Box).
 */
export function floorDivAvailable(
  baseQuantity: number,
  factorMicros: bigint,
): number {
  const baseMicros = BigInt(Math.round(baseQuantity * 1e6));
  return Number(baseMicros / factorMicros);
}
