import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import axios from "@/api/axios.js";
import { usePurchasesStore } from "../usePurchaseStore";
import { landedCostKeys } from "@/features/landed-cost/hooks/useLandedCost";
import type {
  PurchaseDiscrepancyResponse,
  ResolveDiscrepancyInput,
  ResolveOutstandingInput,
  ResolveOutstandingResponse,
} from "../purchase.types";

/** Query keys for the receiving discrepancy trail. */
export const discrepancyKeys = {
  all: ["purchases", "discrepancies"] as const,
  purchase: (purchaseId: number) =>
    ["purchases", "discrepancies", purchaseId] as const,
};

/** Per-delivery audit trail + discrepancies for one purchase. */
export function usePurchaseDiscrepancies(purchaseId: number, enabled = true) {
  return useQuery<PurchaseDiscrepancyResponse["data"]>({
    queryKey: discrepancyKeys.purchase(purchaseId),
    enabled: enabled && Number.isInteger(purchaseId) && purchaseId > 0,
    queryFn: async () => {
      const { data } = await axios.get(
        `/purchases/${purchaseId}/discrepancies`,
      );
      return data.data;
    },
  });
}

/**
 * Short-receiving resolution (Phase 3): record receive-later / backordered,
 * or cancel outstanding quantities (reduces the payable).
 */
export function useResolveOutstanding(purchaseId: number) {
  const queryClient = useQueryClient();

  return useMutation<ResolveOutstandingResponse, Error, ResolveOutstandingInput>({
    mutationFn: async (input: ResolveOutstandingInput) => {
      const { data } = await axios.post(
        `/purchases/${purchaseId}/outstanding-resolution`,
        input,
      );
      return data as ResolveOutstandingResponse;
    },
    onSuccess: async () => {
      const { getPurchases, getPurchaseItems } =
        usePurchasesStore.getState();
      await Promise.all([getPurchases(), getPurchaseItems()]);
      await queryClient.invalidateQueries({
        queryKey: discrepancyKeys.purchase(purchaseId),
      });
      await queryClient.invalidateQueries({ queryKey: ["due-management"] });
      await queryClient.invalidateQueries({ queryKey: landedCostKeys.all });
    },
  });
}

/**
 * Rejection resolution (Phase 4): records supplier_credit / replacement.
 * Recording only — no credit or payment is created automatically.
 */
export function useResolveDiscrepancy(purchaseId: number) {
  const queryClient = useQueryClient();

  return useMutation<
    { success: boolean; data: { discrepancyId: number; status: string } },
    Error,
    { discrepancyId: number; input: ResolveDiscrepancyInput }
  >({
    mutationFn: async ({ discrepancyId, input }) => {
      const { data } = await axios.post(
        `/purchases/${purchaseId}/discrepancies/${discrepancyId}/resolve`,
        input,
      );
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: discrepancyKeys.purchase(purchaseId),
      });
      await queryClient.invalidateQueries({ queryKey: ["due-management"] });
    },
  });
}
