import {
  keepPreviousData,
  useQuery,
} from "@tanstack/react-query";
import axios from "@/api/axios.js";
import type { PurchaseListPage, PurchaseListParams } from "../purchase.types";

/** Query keys for the server-side purchase list (Phase 6). */
export const purchaseListKeys = {
  all: ["purchases", "list"] as const,
  query: (params: PurchaseListParams) =>
    ["purchases", "list", params] as const,
};

function serializeParams(params: PurchaseListParams): string {
  const search = new URLSearchParams();
  if (params.page > 1) search.set("page", String(params.page));
  if (params.pageSize !== 25) search.set("pageSize", String(params.pageSize));
  if (params.search?.trim()) search.set("search", params.search.trim());
  if (params.receivingStatus)
    search.set("receivingStatus", params.receivingStatus);
  if (params.returnStatus) search.set("returnStatus", params.returnStatus);
  if (params.fullyCancelled)
    search.set("fullyCancelled", params.fullyCancelled);
  if (params.supplierId !== undefined)
    search.set("supplierId", String(params.supplierId));
  if (params.dateFrom) search.set("dateFrom", params.dateFrom);
  if (params.dateTo) search.set("dateTo", params.dateTo);
  if (params.sortBy && params.sortBy !== "purchaseDate")
    search.set("sortBy", params.sortBy);
  if (params.sortOrder && params.sortOrder !== "desc")
    search.set("sortOrder", params.sortOrder);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Server-side purchase list (Phase 6): one request carries the filters —
 * the browser never loads item lines or return aggregates.
 *
 * - `keepPreviousData`: switching tabs/pages keeps the previous rows
 *   visible while the next page loads — no flicker, and responses can
 *   never race (each result is bound to its key).
 * - 30s stale time: tab switches within the window are cache hits;
 *   mutations invalidate the list explicitly.
 */
export function usePurchaseList(params: PurchaseListParams) {
  return useQuery<PurchaseListPage>({
    queryKey: purchaseListKeys.query(params),
    queryFn: async () => {
      const { data } = await axios.get(
        `/purchases/list${serializeParams(params)}`,
      );
      return data as PurchaseListPage;
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
