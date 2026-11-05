import { useMutation, useQueryClient } from "@tanstack/react-query";
import { usePurchasesStore } from "../usePurchaseStore";
import useProductStore from "@/features/products/useProductStore";
import { landedCostKeys } from "@/features/landed-cost/hooks/useLandedCost";
import type {
  ReceiveItemsFormValues,
} from "../schemas/receiveItem.schema";
import type { ReceivePurchaseResponse } from "../purchase.types";

/**
 * Receive-purchase mutation (TanStack Query).
 *
 * Wraps the Zustand store action (single code path) and, on success,
 * refreshes every cache the receive flow invalidates:
 * - purchase lists/items (Zustand store)
 * - the products store — receiving changes on-hand stock, and POS stock
 *   reads from that store; skipping this left POS stale until reload
 * - landed-cost queries (a receive can post an adjustment delta)
 * - due-management queries (payment + payable changed)
 */
export function useReceivePurchase() {
  const queryClient = useQueryClient();

  return useMutation<ReceivePurchaseResponse, Error, ReceiveItemsFormValues>({
    mutationFn: (data: ReceiveItemsFormValues) =>
      usePurchasesStore.getState().createReceivePurchase(data),
    onSuccess: async () => {
      const { getPurchases, getPurchaseItems } =
        usePurchasesStore.getState();
      const { getProducts } = useProductStore.getState();
      await Promise.all([getPurchases(), getPurchaseItems(), getProducts()]);
      await queryClient.invalidateQueries({ queryKey: landedCostKeys.all });
      await queryClient.invalidateQueries({ queryKey: ["due-management"] });
    },
  });
}
