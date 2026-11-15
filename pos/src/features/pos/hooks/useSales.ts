import { useQuery } from "@tanstack/react-query";
import { getActiveBusinessId, getActiveLocationId } from "@/api/axios.js";
import { getSalesApi } from "../sales.api.js";

/**
 * Sales list data (Phase 6 Feature 1, domain 3). The LIST lives in TanStack
 * Query; the checkout/refund ACTIONS stay in useSalesStore (they are
 * mutations against the same API and refresh this query on success).
 *
 * Realtime parity note: sale.created never refreshed the sales list before
 * this migration (only the product catalog) — that stays exactly the same.
 */
export const saleKeys = {
  all: ["sales"] as const,
  list: () =>
    ["sales", getActiveBusinessId(), getActiveLocationId(), "list"] as const,
};

export function useSalesQuery() {
  return useQuery({
    queryKey: saleKeys.list(),
    queryFn: getSalesApi,
  });
}
