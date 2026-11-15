import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient.js";
import { getActiveBusinessId, getActiveLocationId } from "@/api/axios.js";
import {
  adjustVariantStockApi,
  createProductApi,
  getProductsApi,
  updateProductApi,
} from "@/features/products/product.api.js";
import { loadProductsWithCache } from "@/features/pos/offline/catalog.js";
import type {
  ProductType,
  StockAdjustmentInput,
  StockAdjustmentResult,
} from "@/features/products/product.types.js";
import type { ProductTypeOutput } from "@/features/products/product.schema.js";

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
  // Aligned with the pre-existing ["product","select-options"] TanStack key
  // (useProductUom / BarcodeGeneratorPage) — one cache for the same payload
  // instead of the old Zustand+TQ dual cache.
  selectOptions: () => ["product", "select-options"] as const,
  variantOptions: () => ["product", "variant-options"] as const,
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

function patchCatalogCache(map: (rows: ProductType[]) => ProductType[]): void {
  queryClient.setQueryData<ProductsCache>(productKeys.catalog(), (current) =>
    current ? { ...current, data: map(current.data) } : current,
  );
}

/**
 * Catalog mutations (Phase 6 Feature 1, domain 2) — plain async functions
 * with the exact contracts the store actions had: local cache patch, NO
 * refetch, same clamping (take clamps at 0 — FIFO sales never go negative).
 * adjustVariantStock is display-first; the backend stays authoritative.
 */
export const productCatalogActions = {
  returnVariantStock: (variantId: number, quantity: number): void =>
    patchCatalogCache((rows) =>
      rows.map((product) => ({
        ...product,
        variants: product.variants.map((variant) =>
          variant.id === variantId
            ? { ...variant, quantity: variant.quantity + quantity }
            : variant,
        ),
      })),
    ),
  takeVariantStock: (variantId: number, quantity: number): void =>
    patchCatalogCache((rows) =>
      rows.map((product) => ({
        ...product,
        variants: product.variants.map((variant) =>
          variant.id === variantId
            ? {
                ...variant,
                quantity: Math.max(0, variant.quantity - quantity),
              }
            : variant,
        ),
      })),
    ),
  adjustVariantStock: async (variantId: number, data: StockAdjustmentInput) => {
    const result = await adjustVariantStockApi(variantId, data);
    patchCatalogCache((rows) =>
      rows.map((product) => ({
        ...product,
        variants: product.variants.map((variant) =>
          variant.id === variantId
            ? { ...variant, quantity: result.quantity }
            : variant,
        ),
      })),
    );
    return result;
  },
  createProduct: async (data: ProductTypeOutput) => {
    const response = await createProductApi(data);
    // The POST returns only { productId } — refresh the catalog so the new
    // product is visible immediately (P3: create-cache synchronization).
    await queryClient.invalidateQueries({ queryKey: productKeys.catalog() });
    return response.data;
  },
  updateProduct: async (id: number, data: ProductTypeOutput) => {
    const result = await updateProductApi(id, data);
    const newVariants = data.variants.filter(
      (variant) => variant.id === undefined,
    );
    if (newVariants.length !== result.addedVariants.length) {
      throw new Error(
        "Product was updated, but the server returned an unexpected number of new variants. Refresh the product list.",
      );
    }

    patchCatalogCache((rows) =>
      rows.map((product) => {
        if (product.id !== id) {
          return product;
        }

        return {
          ...product,
          name: data.name,
          categoryId: data.categoryId,
          brandId: data.brandId,
          unitId: data.unitId,
          description: data.description,
          productType: data.productType,
          hasVariants: data.hasVariants,
          trackingType: data.trackingType,
          status: data.status,
          variants: [
            ...product.variants.map((variant) => {
              const updatedVariant = data.variants.find(
                (item) => item.id === variant.id,
              );
              if (!updatedVariant) return variant;

              return {
                ...variant,
                sku: updatedVariant.sku,
                barcode: updatedVariant.barcode,
                sellingPrice: updatedVariant.sellingPrice,
                alertQuantity: updatedVariant.alertQuantity,
                isDefault: updatedVariant.isDefault,
                status: updatedVariant.status,
                options: updatedVariant.options,
              };
            }),
            ...newVariants.map((variant, index) => {
              const created = result.addedVariants[index];
              if (!created) {
                throw new Error(
                  "Product was updated, but a new variant ID was not returned.",
                );
              }
              return {
                ...variant,
                id: created.id,
                sku: created.sku,
                purchaseCost: variant.purchasePrice,
                quantity: 0,
              };
            }),
          ],
        };
      }),
    );
  },
};
