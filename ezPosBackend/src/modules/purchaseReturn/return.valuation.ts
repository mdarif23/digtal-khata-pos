// Pure purchase-return valuation (Phase 2): ONE implementation of the
// batch-FIFO credit math, shared by the return-preview endpoint and the
// committing transaction, so the preview can never disagree with what the
// return actually pays. No I/O, no locks — callers feed in their own
// snapshots (row-locked in the commit path, plain reads in the preview)
// and apply the returned consumption themselves.

const round2 = (value: number) => Number(Math.round(value * 100) / 100);

export interface ReturnValuationItem {
  purchaseItemId: number;
  variantId: number;
  /**
   * (lineTax − lineDiscount) / orderedQuantity — the amortized per-unit
   * adjustment added on top of the batch's purchase price.
   */
  lineAdjustment: number;
  /**
   * Legacy fallback per-unit price (line-amortized) used ONLY when the
   * variant has no batch rows for this purchase (received before batches
   * were written).
   */
  fallbackUnitPrice: number;
}

export interface ReturnValuationBatch {
  batchId: number;
  variantId: number;
  quantityRemaining: number;
  purchasePrice: number;
}

export interface ReturnConsumption {
  batchId: number;
  purchaseItemId: number;
  quantity: number;
  unitCredit: number;
}

export interface ReturnValuationResult {
  /** Money credited per line (the return's authoritative basis). */
  creditByItemId: Map<number, number>;
  /** Units consumed per batch (callers apply these as decrements). */
  consumedByBatch: Map<number, number>;
  /** FIFO consumption sequence with per-unit credits (breakdowns/landed). */
  consumption: ReturnConsumption[];
  /**
   * Non-null when the requested quantity could not be traced to this
   * purchase's batches (on-hand units came from other purchases) — the
   * commit path must refuse rather than mis-credit.
   */
  shortfall: { purchaseItemId: number; quantity: number } | null;
}

/**
 * Consumes the variant-wide batch pool FIFO (by batch id, lines in
 * purchaseItemId order) exactly like the committing return: each returned
 * unit is credited at its batch's purchase price plus the line's amortized
 * discount/tax adjustment; a legacy no-batch line falls back to its
 * line-amortized price. Lines sharing a variant see each other's
 * consumption through the working pool.
 */
export function computeReturnCredits(
  items: ReturnValuationItem[],
  requestedByItem: Map<number, number>,
  batches: ReturnValuationBatch[],
): ReturnValuationResult {
  const poolByVariant = new Map<number, ReturnValuationBatch[]>();
  for (const batch of [...batches].sort((a, b) => a.batchId - b.batchId)) {
    const pool = poolByVariant.get(batch.variantId) ?? [];
    pool.push(batch);
    poolByVariant.set(batch.variantId, pool);
  }

  const creditByItemId = new Map<number, number>();
  const consumedByBatch = new Map<number, number>();
  const consumption: ReturnConsumption[] = [];
  let shortfall: ReturnValuationResult["shortfall"] = null;

  for (const item of [...items].sort(
    (a, b) => a.purchaseItemId - b.purchaseItemId,
  )) {
    const quantity = requestedByItem.get(item.purchaseItemId) ?? 0;
    if (quantity <= 0) continue;
    const pool = poolByVariant.get(item.variantId) ?? [];

    if (pool.length === 0) {
      // Legacy fallback: received before batch rows were written — the
      // line-amortized price is the only basis available.
      creditByItemId.set(
        item.purchaseItemId,
        round2(quantity * item.fallbackUnitPrice),
      );
      continue;
    }

    let remaining = quantity;
    let lineCredit = 0;
    for (const batch of pool) {
      if (remaining <= 0) break;
      if (batch.quantityRemaining <= 0) continue;
      const removed = Math.min(batch.quantityRemaining, remaining);
      batch.quantityRemaining -= removed;
      remaining -= removed;
      const unitCredit = Math.max(
        0,
        round2(batch.purchasePrice + item.lineAdjustment),
      );
      lineCredit += removed * unitCredit;
      consumedByBatch.set(
        batch.batchId,
        (consumedByBatch.get(batch.batchId) ?? 0) + removed,
      );
      consumption.push({
        batchId: batch.batchId,
        purchaseItemId: item.purchaseItemId,
        quantity: removed,
        unitCredit,
      });
    }

    if (remaining > 0) {
      // Keep the first shortfall; remaining lines still compute so the
      // preview can report every issue at once.
      shortfall ??= { purchaseItemId: item.purchaseItemId, quantity: remaining };
    }
    creditByItemId.set(item.purchaseItemId, round2(lineCredit));
  }

  return { creditByItemId, consumedByBatch, consumption, shortfall };
}
