/**
 * Client-side UOM display math (UOM migration 0062).
 *
 * The SERVER is authoritative: every submission is converted from the
 * entered unit by the backend's own resolved factor. These helpers only
 * drive display hints, prefill values and eligibility previews — they are
 * never a substitute for the server's conversion.
 */

const EPSILON = 1e-9;

/** Round to the 3-dp grid the whole frontend uses for quantities. */
export function roundQuantity(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Display form for quantities: snapped to the 3-dp grid, integers plain,
 * never raw float residue ("1.001" comes from numeric(12,3) values).
 */
export function formatQty(value: number | string | null | undefined): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return "0";
  const rounded = roundQuantity(num);
  return Number.isInteger(rounded)
    ? rounded.toLocaleString()
    : String(rounded);
}

/**
 * entered × factor → base units. The result can carry rounding residue for
 * fractional factors; `isWholeBaseQuantity` reports whether it sits on the
 * integer-stock grid the backend enforces for stock-touching flows.
 */
export function enteredToBaseQuantity(
  entered: number,
  conversionFactor: number,
): number {
  return roundQuantity(entered * conversionFactor);
}

/** Whole base units only — inventory and batches are integer columns. */
export function isWholeBaseQuantity(baseQuantity: number): boolean {
  return Math.abs(baseQuantity - Math.round(baseQuantity)) < EPSILON;
}

/**
 * base ÷ factor → the largest whole amount expressible in the entered unit
 * (floored on the 3-dp grid). Used to render server BASE figures (ordered,
 * received, returned, eligible) in the operator's selected unit.
 */
export function baseToEnteredFloor(
  baseQuantity: number,
  conversionFactor: number,
): number {
  if (!(conversionFactor > 0)) return baseQuantity;
  return Math.floor(roundQuantity(baseQuantity / conversionFactor) + EPSILON);
}

/** "Box" / "Box (bx)" — the unit's display label. */
export function unitDisplayName(unit: {
  unitName: string;
  unitAbbreviation: string | null;
}): string {
  return unit.unitAbbreviation
    ? `${unit.unitName} (${unit.unitAbbreviation})`
    : unit.unitName;
}

/**
 * The live conversion hint under an order/receive line, e.g. "5 Box = 60 pc".
 * Empty when the line is in the base unit or the base unit is unknown.
 */
export function formatConversionHint({
  enteredQuantity,
  unitName,
  conversionFactor,
  baseUnitName,
}: {
  enteredQuantity: number;
  unitName: string;
  conversionFactor: number;
  baseUnitName: string | null | undefined;
}): string {
  if (!baseUnitName || !(conversionFactor > 0) || conversionFactor === 1) {
    return "";
  }
  const base = enteredToBaseQuantity(enteredQuantity, conversionFactor);
  const baseLabel = Number.isInteger(base) ? String(base) : base.toFixed(3);
  return `${enteredQuantity} ${unitName} = ${baseLabel} ${baseUnitName}`;
}

/**
 * The picker label for a packaging unit, e.g. "Box (1 Box = 12 pc)".
 * The base unit renders as its plain name.
 */
export function unitOptionLabel(
  unit: Pick<
    PurchaseUnitOptionLike,
    "unitName" | "unitAbbreviation" | "conversionFactor"
  >,
  baseUnitName: string | null | undefined,
): string {
  if (!(unit.conversionFactor > 0) || unit.conversionFactor === 1) {
    return unitDisplayName(unit);
  }
  const name = unitDisplayName(unit);
  const base = baseUnitName || "base units";
  return `${name} (1 ${unit.unitName} = ${unit.conversionFactor} ${base})`;
}

interface PurchaseUnitOptionLike {
  unitName: string;
  unitAbbreviation: string | null;
  conversionFactor: number;
}

/**
 * Scan-unit compatibility: how many of the line's units one scanned unit
 * contains (scannedFactor ÷ lineFactor). Null when the scanned unit is not
 * an exact multiple of the line's unit — e.g. a piece scan on a Box line —
 * so the caller can reject it instead of silently mis-counting.
 */
export function scanStepInLineUnit(
  lineConversionFactor: number,
  scannedConversionFactor: number,
): number | null {
  const line = roundQuantity(lineConversionFactor);
  const scanned = roundQuantity(scannedConversionFactor);
  if (!(line > 0) || !(scanned > 0)) return null;
  const step = roundQuantity(scanned / line);
  return isWholeBaseQuantity(step) && step > 0 ? step : null;
}

/**
 * The per-package cost implied by a BASE unit cost (cost × factor),
 * rounded to the currency grid. Prefill only — the operator edits it.
 */
export function unitCostFromBase(
  baseUnitCost: number,
  conversionFactor: number,
): number {
  return Math.round(baseUnitCost * conversionFactor * 100) / 100;
}
