/**
 * Decimal-safe money helpers for landed-cost allocation.
 *
 * NO JavaScript floating-point arithmetic is allowed to produce an
 * authoritative money figure. All amounts travel as BigInt "micros"
 * (1 micro = 0.000001 currency unit, matching the numeric(14,6) per-unit
 * columns); inputs convert through their natural storage scale so the
 * conversion is exact:
 *
 *   amount  numeric(14,2) → cents   = round(amount × 100)      → micros = cents × 10⁴
 *   quantity numeric(12,3) → millis  = round(quantity × 1000)
 *   weight  numeric(12,4) → quads   = round(weight × 10⁴)      (normalized to kg)
 *
 * Currency rounding happens ONLY at allocation boundaries: the largest
 * remainder method distributes every residual micro deterministically so the
 * allocated amounts always sum EXACTLY to the total.
 */

export const MICROS_PER_CENT = 10_000n;
export const QUADS_PER_UNIT = 10_000n;

/** numeric(14,2) → BigInt micros. Exact for any 2-dp input. */
export function amountToMicros(amount: number | string): bigint {
  const cents = BigInt(Math.round(Number(amount) * 100));
  return cents * MICROS_PER_CENT;
}

/** BigInt micros → numeric(14,2) number (rounds to cents). */
export function microsToAmount(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

/** BigInt micros → numeric(14,6) number. */
export function microsToPerUnit(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

/** numeric(12,3) quantity → BigInt millis. */
export function quantityToMillis(quantity: number | string): bigint {
  return BigInt(Math.round(Number(quantity) * 1000));
}

/** numeric(12,4) weight → BigInt quads (1e-4 units). */
function weightToQuads(weight: number | string): bigint {
  return BigInt(Math.round(Number(weight) * 10_000));
}

const LB_TO_KG_NUM = 45_359_237n; // 1 lb = 0.45359237 kg (exact definition)
const LB_TO_KG_DEN = 100_000_000n;
const OZ_TO_KG_NUM = 28_349_523_125n; // lb / 16 = 0.028349523125 kg
const OZ_TO_KG_DEN = 1_000_000_000_000n;

/**
 * Normalize a (weight, unit) pair to kg quads (numeric(12,4) scale).
 * Supported units: kg, g, lb, oz. Values are truncated to the kg 4-dp grid —
 * the same grid the weight_snapshot column stores.
 */
export function weightToKgQuads(
  weight: number | string,
  unit: string | null | undefined,
): bigint {
  const quads = weightToQuads(weight);
  switch ((unit ?? "kg").toLowerCase()) {
    case "kg":
      return quads;
    case "g":
      return quads / 1000n;
    case "lb":
      return (quads * LB_TO_KG_NUM) / LB_TO_KG_DEN;
    case "oz":
      return (quads * OZ_TO_KG_NUM) / OZ_TO_KG_DEN;
    default:
      throw new Error(`Unsupported weight unit: ${unit}`);
  }
}

/**
 * Product-line net value in micros: quantity × unit_cost − line discount,
 * each converted exactly from its storage scale (3dp × 2dp − 2dp).
 */
export function lineNetValueMicros(
  quantityMillis: bigint,
  unitCostCents: bigint,
  discountCents: bigint,
): bigint {
  const grossMicros = quantityMillis * unitCostCents * 10n;
  const discountMicros = discountCents * MICROS_PER_CENT;
  return grossMicros > discountMicros ? grossMicros - discountMicros : 0n;
}

export interface Allocatable {
  key: string;
  basisMicros: bigint;
}

/**
 * Largest-remainder allocation: proportional by basis, with the residual
 * micros distributed to the largest fractional parts (deterministic
 * tie-break by input order). The result sums EXACTLY to `total`.
 */
export function allocateByBasis(
  total: bigint,
  items: Allocatable[],
): Map<string, bigint> {
  const result = new Map<string, bigint>();
  if (items.length === 0) return result;
  if (total === 0n) {
    for (const item of items) result.set(item.key, 0n);
    return result;
  }

  const totalBasis = items.reduce((sum, i) => sum + i.basisMicros, 0n);
  if (totalBasis <= 0n) {
    throw new Error("Zero allocation basis");
  }

  let distributed = 0n;
  const remainders: { key: string; remainder: bigint; index: number }[] = [];
  items.forEach((item, index) => {
    const raw = (total * item.basisMicros) / totalBasis;
    result.set(item.key, raw);
    distributed += raw;
    remainders.push({
      key: item.key,
      remainder: (total * item.basisMicros) % totalBasis,
      index,
    });
  });

  let residual = total - distributed;
  remainders.sort(
    (a, b) =>
      (a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 : a.index - b.index),
  );
  for (const entry of remainders) {
    if (residual <= 0n) break;
    result.set(entry.key, result.get(entry.key)! + 1n);
    residual -= 1n;
  }
  return result;
}
