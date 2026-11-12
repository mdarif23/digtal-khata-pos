import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteVariantWarrantyConfigApi,
  getProductWarrantyConfigApi,
  putProductWarrantyConfigApi,
  putVariantWarrantyConfigApi,
} from "../warrantyConfig.api.js";
import type {
  ProductWarrantyConfigView,
  RemoveVariantWarrantyResponse,
  WarrantyConfigMutationResponse,
  WarrantyConfigWrite,
} from "../warrantyConfig.types.js";

/** TanStack Query key factory — follows the productUom convention. */
export const productWarrantyConfigKeys = {
  all: ["product-warranty-config"] as const,
  product: (productId: number) =>
    [...productWarrantyConfigKeys.all, "product", productId] as const,
};

/**
 * The warranty configuration for one product (default + per-variant
 * overrides). Null/invalid ids are never fetched — a product must exist
 * before warranty configuration (post-create step, like packaging units).
 */
export function useProductWarrantyConfig(productId: number | null) {
  return useQuery<ProductWarrantyConfigView, Error>({
    queryKey: productWarrantyConfigKeys.product(productId ?? 0),
    queryFn: () => getProductWarrantyConfigApi(productId as number),
    enabled: productId !== null && Number.isInteger(productId) && productId > 0,
  });
}

/** After every mutation: refetch this product's warranty configuration. */
function useInvalidateProductWarrantyConfig() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: productWarrantyConfigKeys.all,
    });
  };
}

export function usePutProductWarrantyConfig(productId: number) {
  const invalidate = useInvalidateProductWarrantyConfig();
  return useMutation<
    WarrantyConfigMutationResponse,
    Error,
    WarrantyConfigWrite
  >({
    mutationFn: (payload) => putProductWarrantyConfigApi(productId, payload),
    onSuccess: invalidate,
  });
}

export function usePutVariantWarrantyConfig(productId: number) {
  const invalidate = useInvalidateProductWarrantyConfig();
  return useMutation<
    WarrantyConfigMutationResponse,
    Error,
    { variantId: number; payload: WarrantyConfigWrite }
  >({
    mutationFn: ({ variantId, payload }) =>
      putVariantWarrantyConfigApi(productId, variantId, payload),
    onSuccess: invalidate,
  });
}

export function useDeleteVariantWarrantyConfig(productId: number) {
  const invalidate = useInvalidateProductWarrantyConfig();
  return useMutation<RemoveVariantWarrantyResponse, Error, number>({
    mutationFn: (variantId) =>
      deleteVariantWarrantyConfigApi(productId, variantId),
    onSuccess: invalidate,
  });
}
