import { useQuery } from "@tanstack/react-query";
import axios from "@/api/axios.js";
import type { ReturnableSerials } from "../purchase.types";

/**
 * Phase 5: the in-stock serial numbers eligible for return, per
 * serial-tracked line of the purchase. Loaded once per page visit; the
 * committing return re-validates every selection server-side.
 */
export function useReturnableSerials(purchaseId: number | null) {
  return useQuery<ReturnableSerials>({
    queryKey: ["purchases", "return-serials", purchaseId],
    queryFn: async () => {
      const { data } = await axios.get(
        `/purchases/${purchaseId}/return-serials`,
      );
      return data.data as ReturnableSerials;
    },
    enabled: purchaseId !== null,
    staleTime: 15_000,
  });
}
