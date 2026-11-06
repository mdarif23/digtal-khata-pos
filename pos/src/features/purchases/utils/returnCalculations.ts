import type { PurchasesItems } from "../purchase.types";

/**
 * Shared purchase-return math. The backend recomputes everything
 * authoritatively (credit = per-unit batch cost, FIFO) — these helpers only
 * drive the UI's estimates and clamps.
 */

/**
 * Max units returnable for a line: received units not yet returned, capped
 * by on-hand stock at the receiving location minus quantities already
 * selected for sibling lines sharing the same variant.
 */
export function maxReturnableQuantity({
  receivedQuantity,
  alreadyReturned,
  availableStock,
  alreadySelectedForVariant,
}: {
  receivedQuantity: number;
  alreadyReturned: number;
  availableStock: number;
  alreadySelectedForVariant: number;
}): number {
  const remainingReceived = Math.max(
    0,
    Number(receivedQuantity) - Number(alreadyReturned || 0),
  );
  const stock = Math.max(
    0,
    Number(availableStock ?? 0) - Number(alreadySelectedForVariant || 0),
  );
  return Math.floor(Math.min(remainingReceived, stock));
}

/** Convenience overload for a purchase item line. */
export function maxReturnableForItem(
  item: PurchasesItems,
  alreadyReturned: number,
  alreadySelectedForVariant: number,
): number {
  return maxReturnableQuantity({
    receivedQuantity: Number(item.receivedQuantity) || 0,
    alreadyReturned,
    availableStock: Number(item.availableStock ?? 0),
    alreadySelectedForVariant,
  });
}

/**
 * Client-side ESTIMATE of the per-unit credit: the line's amortized price
 * (order cost − line discount + line tax, per ordered unit). The server
 * credits per-unit BATCH costs (FIFO), which the client cannot see — the
 * toast shows the server's authoritative total after processing.
 */
export function estimateReturnUnitPrice(item: PurchasesItems): number {
  const quantity = Number(item.quantity);
  if (quantity <= 0) return 0;
  const lineTotal =
    quantity * Number(item.unitCost) -
    Number(item.discount || 0) +
    Number(item.tax || 0);
  return Math.max(0, Number((lineTotal / quantity).toFixed(2)));
}
