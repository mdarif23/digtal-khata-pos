import { BadRequestError } from "../../utils/handleError.js";
import type { CreatePurchaseReturnInput } from "./purchaseReturn.schema.js";

// Pure purchase-return guards, mirroring the receive/receive.validation.ts
// convention: business rules enforced server-side, no SQL here — the
// service loads (and row-locks) the data, these functions judge it.

type ChangedItem = CreatePurchaseReturnInput["changedItems"][number];

/** Duplicate purchase items in one request are rejected; returns the ids. */
export function validateReturnRequest(changedItems: ChangedItem[]): number[] {
  if (changedItems.length === 0) {
    throw new BadRequestError("Select at least one item to return.");
  }
  const purchaseItemIds = changedItems.map((item) => item.purchaseItemId);
  if (new Set(purchaseItemIds).size !== purchaseItemIds.length) {
    throw new BadRequestError("Duplicate purchase items are not allowed.");
  }
  return purchaseItemIds;
}

type ReturnablePurchase = {
  supplierId: number | null;
  locationId: number | null;
};

/** Returns need an eligible supplier and a recorded receiving location. */
export function assertReturnablePurchase<T extends ReturnablePurchase>(
  purchase: T,
): asserts purchase is T & { supplierId: number; locationId: number } {
  if (purchase.supplierId === null) {
    throw new BadRequestError(
      "A supplier must be assigned to process a purchase return.",
    );
  }
  // Returns deduct stock where the purchase was received.
  if (purchase.locationId === null) {
    throw new BadRequestError(
      "This purchase has no receiving location recorded and cannot be returned.",
    );
  }
}

/** Every requested id must be a line of this purchase (same business). */
export function assertItemsBelongToPurchase(
  items: { id: number }[],
  purchaseItemIds: number[],
): void {
  if (items.length !== purchaseItemIds.length) {
    throw new BadRequestError(
      "One or more selected items do not belong to this purchase order.",
    );
  }
}

/** Total return demand per variant across lines sharing the same variant. */
export function aggregateRequestedByVariant(
  items: { id: number; variantId: number }[],
  requestedByItem: Map<number, number>,
): Map<number, number> {
  const requestedByVariant = new Map<number, number>();
  for (const item of items) {
    const quantity = requestedByItem.get(item.id) ?? 0;
    requestedByVariant.set(
      item.variantId,
      (requestedByVariant.get(item.variantId) ?? 0) + quantity,
    );
  }
  return requestedByVariant;
}

/**
 * Eligibility: never return more than was received (minus previous
 * returns), and never more than is on hand at the receiving location
 * (variant-scoped — lines sharing a variant draw from the same stock).
 */
export function assertReturnEligibility({
  items,
  requestedByItem,
  returnedByItem,
  stockByVariant,
}: {
  items: { id: number; variantId: number; receivedQuantity: number }[];
  requestedByItem: Map<number, number>;
  returnedByItem: Map<number, number>;
  stockByVariant: Map<number, number>;
}): Map<number, number> {
  for (const item of items) {
    const quantity = requestedByItem.get(item.id) ?? 0;
    const remainingReceived =
      Number(item.receivedQuantity) - (returnedByItem.get(item.id) ?? 0);

    if (quantity > remainingReceived) {
      throw new BadRequestError(
        `Cannot return ${quantity} of item ${item.id}; only ${Math.max(remainingReceived, 0)} received units remain eligible.`,
      );
    }
  }

  const requestedByVariant = aggregateRequestedByVariant(
    items,
    requestedByItem,
  );
  for (const [variantId, quantity] of requestedByVariant) {
    const available = stockByVariant.get(variantId);
    if (available === undefined || quantity > available) {
      throw new BadRequestError(
        `Insufficient on-hand stock to return ${quantity} unit(s) of variant ${variantId}.`,
      );
    }
  }
  return requestedByVariant;
}
