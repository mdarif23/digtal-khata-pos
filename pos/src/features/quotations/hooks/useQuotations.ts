import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getActiveBusinessId } from "@/api/axios.js";
import { listQuotationsApi } from "../quotations.api.js";

/**
 * Quotation list (Phase 6 Feature 1, domain 4) — filterable server-side
 * list; keepPreviousData mirrors the old page behavior where rows kept
 * their previous value while a new filter's fetch was in flight.
 */
export const quotationKeys = {
  all: ["quotations"] as const,
  list: (filters: { status?: string; search?: string }) =>
    ["quotations", getActiveBusinessId(), "list", filters] as const,
};

export type QuotationListFilters = Parameters<typeof listQuotationsApi>[0];

export function useQuotationsQuery(filters: QuotationListFilters) {
  return useQuery({
    queryKey: quotationKeys.list(filters),
    queryFn: () => listQuotationsApi(filters),
    placeholderData: keepPreviousData,
  });
}
