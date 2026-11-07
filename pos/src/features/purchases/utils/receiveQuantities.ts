import type { PurchasesItems } from "../purchase.types";

/**
 * Receiving quantity helpers (Phase 5). The backend re-validates everything
 * authoritatively — these drive the UI's outstanding math and the
 * over-receiving warning.
 */

/** Outstanding = ordered − received − cancelled (cancelled is written off). */
export function outstandingOf(item: PurchasesItems): number {
  return Math.max(
    0,
    Number(item.quantity) -
      Number(item.receivedQuantity || 0) -
      Number(item.cancelledQuantity || 0),
  );
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
