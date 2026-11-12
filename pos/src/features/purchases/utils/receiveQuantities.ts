import type { PurchasesItems } from "../purchase.types";
import {
  baseToEnteredFloor,
  enteredToBaseQuantity,
  roundQuantity,
} from "./uom.js";

/**
 * Receiving quantity helpers (Phase 5). The backend re-validates everything
 * authoritatively — these drive the UI's outstanding math and the
 * over-receiving warning.
 */

/** Outstanding = ordered − received − cancelled (cancelled is written off).
 *  Rounded to the 3-dp grid — raw float subtraction prints residues like
 *  0.023999999999999133 for numeric(12,3) quantities. */
export function outstandingOf(item: PurchasesItems): number {
  return roundQuantity(
    Math.max(
      0,
      Number(item.quantity) -
        Number(item.receivedQuantity || 0) -
        Number(item.cancelledQuantity || 0),
    ),
  );
}

/**
 * UOM (migration 0062): the outstanding quantity expressed in the line's
 * SELECTED unit — floored, because the base remainder a package cannot
 * cover must be received in the base unit instead. The factor is the
 * selected unit's (1 = base).
 */
export function outstandingInUnitOf(
  item: PurchasesItems,
  conversionFactor: number,
): number {
  return baseToEnteredFloor(outstandingOf(item), conversionFactor);
}

/**
 * Over-receive info for a line: how many units the session accepts beyond
 * the outstanding quantity. Null when the acceptance is within the
 * outstanding remainder.
 */
export function overReceiveOf(
  item: PurchasesItems,
  receiveNow: number,
): { overQuantity: number } | null {
  const over = Number(receiveNow || 0) - outstandingOf(item);
  return over > 0 ? { overQuantity: over } : null;
}

/**
 * UOM-aware over-receive: receiveNow is in the SELECTED unit, so both sides
 * are compared in base units and the surplus is reported in the SELECTED
 * unit (the same figure the operator can subtract from their input).
 */
export function overReceiveInUnitOf(
  item: PurchasesItems,
  receiveNow: number,
  conversionFactor: number,
): { overQuantity: number } | null {
  if (roundQuantity(conversionFactor) === 1) {
    return overReceiveOf(item, receiveNow);
  }
  const enteredBase = enteredToBaseQuantity(
    Number(receiveNow || 0),
    conversionFactor,
  );
  const overBase = enteredBase - outstandingOf(item);
  if (overBase <= 0) return null;
  return {
    overQuantity: roundQuantity(overBase / conversionFactor),
  };
}
