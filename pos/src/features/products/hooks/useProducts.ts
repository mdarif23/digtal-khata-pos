import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient.js";
import { getActiveBusinessId, getActiveLocationId } from "@/api/axios.js";
import { getProductsApi } from "@/features/products/product.api.js";
import { loadProductsWithCache } from "@/features/pos/offline/catalog.js";
import type { ProductType } from "@/features/products/product.types.js";

/**
 * Product catalog data (Phase 6 Feature 1, domain 2). The canonical catalog
 * list moves to TanStack Query; option groups (brands/categories/suppliers/
 * units, variant types/options) stay in useProductStore until their own
 * migration commit.
 *
 * The queryFn IS the offline wrapper — loadProductsWithCache owns the
 * IndexedDB catalog cache exactly as before (network error → cached rows +
 * offlineMode; cached === null → rethrow), so offline checkout keeps
 * working with one source of truth.
 */

export interface ProductsCache {
  data: ProductType[];
  fromCache: boolean;
}

export const productKeys = {
  all: ["products"] as const,
  catalog: () =>
    [
      "products",
      getActiveBusinessId(),
      getActiveLocationId(),
      "catalog",
    ] as const,
};

/** Shared queryFn — also used by useInitializeApp's warm-start prefetch. */
export function fetchProductsWithOfflineCache(): Promise<ProductsCache> {
  return loadProductsWithCache<ProductType>(getProductsApi);
}

export function useProductsQuery() {
  return useQuery({
    queryKey: productKeys.catalog(),
    queryFn: fetchProductsWithOfflineCache,
    select: (result) => result.data,
  });
}

/**
 * Imperative read of the current cached catalog — replaces the old
 * useProductStore.getState().products reads in non-reactive contexts
 * (barcode scan chains, cart restore, offline allowance prep).
 */
export function readProductsCache(): ProductType[] {
  return queryClient.getQueryData<ProductsCache>(productKeys.catalog())?.data ?? [];
}
