import type { PurchaseStoreType } from "../purchase.types";

export const RETURNED = "Returned";
export const PARTIALLY_RETURNED = "Partially returned";

type ReturnStatus = typeof RETURNED | typeof PARTIALLY_RETURNED;

/**
 * Derive per-purchase return status from actual accepted received
 * quantities vs actual returned quantities (Phase 2: single shared source
 * — the same map feeds filtering, tab counts, and the Return status
 * column). Receiving status and return status are INDEPENDENT dimensions:
 * this derivation never reads the purchase's receiving status.
 *
 * Purchases with no returns get no entry. Multiple returns against the
 * same item are summed (the backend pre-aggregates per item).
 */
export function deriveReturnStatuses(
  purchaseItems: { id: number; purchaseId: number; receivedQuantity: number }[],
  returnedItems: { purchaseItemId: number; returnQuantity: number }[],
): Map<number, ReturnStatus> {
  const returnedByItem = new Map(
    returnedItems.map((item) => [
      item.purchaseItemId,
      Number(item.returnQuantity) || 0,
    ]),
  );
  const totalsByPurchase = new Map<
    number,
    { received: number; returned: number }
  >();

  for (const item of purchaseItems) {
    const totals = totalsByPurchase.get(item.purchaseId) ?? {
      received: 0,
      returned: 0,
    };
    totals.received += Number(item.receivedQuantity) || 0;
    totals.returned += returnedByItem.get(item.id) ?? 0;
    totalsByPurchase.set(item.purchaseId, totals);
  }

  return new Map(
    [...totalsByPurchase].flatMap(([purchaseId, totals]) => {
      if (totals.returned <= 0) return [];
      return [
        [
          purchaseId,
          totals.returned >= totals.received ? RETURNED : PARTIALLY_RETURNED,
        ] as const,
      ];
    }),
  );
}

export type PurchaseFilter =
  | "all"
  | "ordered"
  | "partially_received"
  | "received"
  | "partially_returned"
  | "returned"
  | "cancelled";

export const PURCHASE_FILTERS: {
  value: PurchaseFilter;
  label: string;
  /** Server query params this tab maps to (Phase 6: server-side filtering). */
  params: {
    receivingStatus?: "ordered" | "partially_received" | "received";
    returnStatus?: "Returned" | "Partially returned";
    fullyCancelled?: "true" | "false";
  };
}[] = [
  { value: "all", label: "All orders", params: {} },
  {
    value: "ordered",
    label: "Ordered",
    params: { receivingStatus: "ordered" },
  },
  {
    value: "partially_received",
    label: "Partially received",
    params: { receivingStatus: "partially_received" },
  },
  {
    value: "received",
    label: "Received",
    params: { receivingStatus: "received" },
  },
  {
    value: "partially_returned",
    label: "Partially returned",
    params: { returnStatus: "Partially returned" },
  },
  { value: "returned", label: "Returned", params: { returnStatus: "Returned" } },
  { value: "cancelled", label: "Cancelled", params: { fullyCancelled: "true" } },
];

/**
 * Filter predicate for the purchases list (shared by the tab counts and
 * the visible rows so the two can never disagree).
 *
 * The return state is a DERIVED dimension (returns never change the
 * purchase's receiving status), so it gets its own tabs — and fully
 * returned orders are excluded from "Received": their goods are gone, so
 * grouping them there read as a filtering bug.
 */
export function matchesPurchaseFilter(
  purchase: Pick<PurchaseStoreType, "status" | "fullyCancelled">,
  filter: PurchaseFilter,
  returnStatus: string | undefined,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "returned":
      return returnStatus === "Returned";
    case "partially_returned":
      return returnStatus === "Partially returned";
    case "cancelled":
      // Workflow-complete with ZERO accepted goods (Phase 3 derived flag).
      return purchase.fullyCancelled === true;
    default:
      // Fully-returned orders leave the Received tab (goods are gone) —
      // and so do fully-cancelled ones (nothing ever arrived).
      if (filter === "received") {
        if (returnStatus === "Returned" || purchase.fullyCancelled === true) {
          return false;
        }
      }
      return purchase.status === filter;
  }
}
