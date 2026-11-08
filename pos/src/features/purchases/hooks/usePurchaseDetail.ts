import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import axios from "@/api/axios.js";
import type { PurchaseDetail } from "../purchase.types.js";

/** Query keys for the purchase details drawer (Phase 11). */
export const purchaseDetailKeys = {
  all: ["purchases", "detail"] as const,
  detail: (purchaseId: number) => ["purchases", "detail", purchaseId] as const,
};

/**
 * Landed-cost context for the drawer's landed-cost panel. The endpoint
 * 400s with `not_received` while nothing has been received — that is a
 * normal "no landed cost yet" state, not an error, so the hook resolves
 * it to null instead of surfacing a failure.
 */
export function usePurchaseLandedCostContext(purchaseId: number | null) {
  return useQuery<{
    purchase: { id: number; purchaseOrderNumber: string };
    lines: unknown[];
    existingStatus: string | null;
    existingDocumentId: number | null;
  } | null>({
    queryKey: ["purchases", "landed-cost-context", purchaseId],
    queryFn: async () => {
      try {
        const { data } = await axios.get(
          `/purchases/${purchaseId}/landed-cost`,
        );
        return data.data;
      } catch (err) {
        const status = isAxiosError(err) ? err.response?.status : undefined;
        if (status === 400 || status === 404) return null;
        throw err;
      }
    },
    enabled: purchaseId !== null,
    staleTime: 15_000,
  });
}

/** Header + item lines for the details drawer. */
export function usePurchaseDetail(purchaseId: number | null) {
  return useQuery<PurchaseDetail>({
    queryKey: purchaseDetailKeys.detail(purchaseId ?? 0),
    queryFn: async () => {
      const { data } = await axios.get(`/purchases/${purchaseId}`);
      return data as PurchaseDetail;
    },
    enabled: purchaseId !== null,
    staleTime: 15_000,
  });
}
