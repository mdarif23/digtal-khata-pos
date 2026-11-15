import { useQuery } from "@tanstack/react-query";
import { getActiveBusinessId } from "@/api/axios.js";
import { getCustomersApi } from "@/api/customer.api.js";
import { loadCustomersWithCache } from "@/features/pos/offline/catalog.js";
import type { InputValue } from "@/types/customers.types.js";

/**
 * Customers list data (Phase 6 Feature 1, domain 1). The LIST lives in
 * TanStack Query; the selected-customer checkout state stays in
 * useCustomerStore — it is UI state, not data-fetching.
 *
 * The queryFn IS the offline wrapper: on network failure the IndexedDB
 * catalog copy loads exactly as before (loadCustomersWithCache contract:
 * network error → cached rows + offlineMode; cached === null → rethrow).
 *
 * Keys are business-scoped. Location/business switching is a full page
 * reload today (api/axios switchLocation), so keys cannot go stale across
 * scopes — they are scoped anyway for the future business switcher.
 */

export interface CustomersCache {
  data: InputValue[];
  fromCache: boolean;
}

export const customerKeys = {
  all: ["customers"] as const,
  list: () => ["customers", getActiveBusinessId(), "list"] as const,
};

/** Shared queryFn — also used by useInitializeApp's warm-start prefetch. */
export function fetchCustomersWithOfflineCache(): Promise<CustomersCache> {
  return loadCustomersWithCache(getCustomersApi);
}

export function useCustomersQuery() {
  return useQuery({
    queryKey: customerKeys.list(),
    queryFn: fetchCustomersWithOfflineCache,
    select: (result) => result.data,
  });
}
