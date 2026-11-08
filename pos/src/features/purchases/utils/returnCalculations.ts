/**
 * Shared purchase-return math. The backend recomputes everything
 * authoritatively (credit = per-unit batch cost, FIFO) — these helpers only
 * drive the UI's estimates and clamps. They accept a STRUCTURAL line shape
 * so both store items (PurchasesItems) and detail items
 * (PurchaseDetailItem) work; Phase 1 feeds them detail lines whose
 * availableStock is the RECEIVING location's stock.
 */

export interface ReturnItemLine {
  quantity: number;
  receivedQuantity: number;
  availableStock: number | null;
  unitCost: number;
  discount: number | null;
  tax: number | null;
}

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
  item: ReturnItemLine,
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
export function estimateReturnUnitPrice(item: ReturnItemLine): number {
  const quantity = Number(item.quantity);
  if (quantity <= 0) return 0;
  const lineTotal =
    quantity * Number(item.unitCost) -
    Number(item.discount || 0) +
    Number(item.tax || 0);
  return Math.max(0, Number((lineTotal / quantity).toFixed(2)));
}

/**
 * Phase 4: barcode-scan allocation across sibling lines sharing a variant.
 * Deterministic: the FIRST line in purchase-order sequence with remaining
 * capacity — its received units not yet returned nor already selected —
 * takes the scanned unit, subject to the variant-wide stock cap at the
 * receiving location (all sibling lines share that stock). Returns the
 * UPDATED selection map, or null when no line can take another unit.
 */
export function allocateScannedUnit({
  lines,
  variantId,
  returnedByItem,
  returnQuantities,
}: {
  /** The purchase's lines, in purchase-order sequence. */
  lines: {
    id: number;
    variantId: number;
    receivedQuantity: number;
    availableStock: number | null;
  }[];
  variantId: number;
  returnedByItem: Map<number, number>;
  returnQuantities: Record<number, number>;
}): Record<number, number> | null {
  const variantLines = lines.filter((line) => line.variantId === variantId);
  if (variantLines.length === 0) return null;

  // Sibling selections share the variant's stock at the receiving location.
  const selectedForVariant = variantLines.reduce(
    (sum, line) => sum + (returnQuantities[line.id] ?? 0),
    0,
  );
  const remainingStock = Math.max(
    0,
    Number(variantLines[0]?.availableStock ?? 0) - selectedForVariant,
  );
  if (remainingStock <= 0) return null;

  for (const line of variantLines) {
    const remainingReceived = Math.max(
      0,
      Number(line.receivedQuantity) -
        (returnedByItem.get(line.id) ?? 0) -
        (returnQuantities[line.id] ?? 0),
    );
    if (remainingReceived > 0) {
      return {
        ...returnQuantities,
        [line.id]: (returnQuantities[line.id] ?? 0) + 1,
      };
    }
  }
  return null;
}
