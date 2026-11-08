import {
  keepPreviousData,
  useQuery,
} from "@tanstack/react-query";
import axios from "@/api/axios.js";
import type { PurchaseReturnPreview } from "../purchase.types";

/**
 * Server-authoritative return preview (Phase 2). POST is used because the
 * preview carries the user's selected quantities; the query key includes
 * them so TanStack caches per selection and `keepPreviousData` keeps the
 * previous numbers on screen while a new selection is in flight (the page
 * debounces the selection before it reaches this hook). While loading the
 * page shows no authoritative amounts and disables submission.
 */
export function usePurchaseReturnPreview(
  purchaseId: number | null,
  changedItems: { purchaseItemId: number; quantity: number }[],
) {
  const hasSelection = changedItems.length > 0;
  const selectionKey = changedItems
    .map((item) => `${item.purchaseItemId}:${item.quantity}`)
    .join("|");

  return useQuery<PurchaseReturnPreview>({
    queryKey: [
      "purchases",
      "return-preview",
      purchaseId,
      selectionKey,
    ],
    queryFn: async () => {
      const { data } = await axios.post(
        `/purchases/${purchaseId}/return-preview`,
        { changedItems },
      );
      return data.data as PurchaseReturnPreview;
    },
    enabled: purchaseId !== null && hasSelection,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
    gcTime: 0,
  });
}
