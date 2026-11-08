import { useMutation, useQueryClient } from "@tanstack/react-query";
import { purchaseReturnApi } from "../purchase.api.js";
import { usePurchasesStore } from "../usePurchaseStore";
import useProductStore from "@/features/products/useProductStore";
import { purchaseDetailKeys } from "./usePurchaseDetail";
import { landedCostKeys } from "@/features/landed-cost/hooks/useLandedCost";
import type {
  PurchaseReturnInput,
  PurchaseReturnResponse,
} from "../purchase.types";

/**
 * Purchase-return mutation (Phase 6: TanStack Query owns the mutation —
 * the store indirection is gone; the API client is called directly).
 *
 * onSuccess invalidates exactly the server data a return makes stale:
 * - THIS purchase's detail (drawer + return page share the key)
 * - this purchase's returnable serials and return previews
 * - landed-cost summaries (a return can post a reversal)
 * - the purchase list/aggregates and due management (payable changed)
 *
 * Zustand stores are ALSO refreshed on purpose (compatibility, not
 * duplication): other screens (purchase creation, POS product stock)
 * still read them. The return page itself reads only TanStack queries.
 */
export function usePurchaseReturn() {
  const queryClient = useQueryClient();

  return useMutation<PurchaseReturnResponse, Error, PurchaseReturnInput>({
    mutationFn: (data: PurchaseReturnInput) => purchaseReturnApi(data),
    onSuccess: async (_response, variables) => {
      const purchaseId = variables.orderId;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: purchaseDetailKeys.all }),
        queryClient.invalidateQueries({
          queryKey: ["purchases", "return-serials", purchaseId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["purchases", "return-preview", purchaseId],
        }),
        queryClient.invalidateQueries({ queryKey: landedCostKeys.all }),
        queryClient.invalidateQueries({ queryKey: ["due-management"] }),
        queryClient.invalidateQueries({ queryKey: ["purchases", "list"] }),
      ]);
      // Zustand consumers outside this page (documented dependency).
      const { getPurchases, getPurchaseItems, getPurchasesReturnItems } =
        usePurchasesStore.getState();
      const { getProducts } = useProductStore.getState();
      await Promise.all([
        getPurchases(),
        getPurchaseItems(),
        getPurchasesReturnItems(),
        getProducts(),
      ]);
    },
  });
}
