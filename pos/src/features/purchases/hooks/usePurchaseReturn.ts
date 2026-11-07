import { useMutation, useQueryClient } from "@tanstack/react-query";
import { usePurchasesStore } from "../usePurchaseStore";
import useProductStore from "@/features/products/useProductStore";
import { landedCostKeys } from "@/features/landed-cost/hooks/useLandedCost";
import type { PurchaseReturnInput } from "../purchase.types";
import type { PurchaseReturnResponse } from "../purchase.types";

/**
 * Purchase-return mutation (TanStack Query).
 *
 * Wraps the Zustand store action (single code path) and, on success,
 * refreshes every cache the return flow invalidates:
 * - purchase lists/items/return items (Zustand store)
 * - the products store — a return reduces on-hand stock, and POS stock
 *   reads from that store
 * - landed-cost queries (a return can post a reversal adjustment)
 * - due-management queries (payable + supplier ledger changed)
 */
export function usePurchaseReturn() {
  const queryClient = useQueryClient();

  return useMutation<PurchaseReturnResponse, Error, PurchaseReturnInput>({
    mutationFn: (data: PurchaseReturnInput) =>
      usePurchasesStore.getState().purchaseReturn(data),
    onSuccess: async () => {
      const { getPurchases, getPurchaseItems, getPurchasesReturnItems } =
        usePurchasesStore.getState();
      const { getProducts } = useProductStore.getState();
      await Promise.all([
        getPurchases(),
        getPurchaseItems(),
        getPurchasesReturnItems(),
        getProducts(),
      ]);
      await queryClient.invalidateQueries({ queryKey: landedCostKeys.all });
      await queryClient.invalidateQueries({ queryKey: ["due-management"] });
      await queryClient.invalidateQueries({
        queryKey: ["purchases", "list"],
      });
    },
  });
}
