import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import useProductStore from "../useProductStore.js";
import {
  addPackagingUnitApi,
  deactivatePackagingUnitApi,
  getProductUomApi,
  updatePackagingUnitApi,
} from "../uom.api.js";
import type {
  AddPackagingUnitPayload,
  ProductUomConfig,
  UomMutationResponse,
  UpdatePackagingUnitPayload,
} from "../uom.types.js";

/** TanStack Query key factory — follows the landed-cost/procurement convention. */
export const productUomKeys = {
  all: ["product-uom"] as const,
  product: (productId: number) =>
    [...productUomKeys.all, "product", productId] as const,
};

/**
 * The Units & Packaging configuration for one product. Null/invalid ids
 * are never fetched (a product must exist before packaging units can be
 * configured — the backend requires a productId).
 */
export function useProductUom(productId: number | null) {
  return useQuery<ProductUomConfig, Error>({
    queryKey: productUomKeys.product(productId ?? 0),
    queryFn: () => getProductUomApi(productId as number),
    enabled: productId !== null && Number.isInteger(productId) && productId > 0,
  });
}

/**
 * After every mutation: refetch this product's UOM config, and refresh the
 * unit pickers (productSelectOptions feeds unit dropdowns; the
 * ["product", "select-options"] TanStack key covers the react-query
 * consumers — same convention as useBarcodes).
 */
function useInvalidateProductUom() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: productUomKeys.all });
    void queryClient.invalidateQueries({
      queryKey: ["product", "select-options"],
    });
    void useProductStore.getState().getProductSelectOptions();
  };
}

export function useAddPackagingUnit(productId: number) {
  const invalidate = useInvalidateProductUom();
  return useMutation<UomMutationResponse, Error, AddPackagingUnitPayload>({
    mutationFn: (payload) => addPackagingUnitApi(productId, payload),
    onSuccess: invalidate,
  });
}

export function useUpdatePackagingUnit() {
  const invalidate = useInvalidateProductUom();
  return useMutation<
    UomMutationResponse,
    Error,
    { conversionId: number; payload: UpdatePackagingUnitPayload }
  >({
    mutationFn: ({ conversionId, payload }) =>
      updatePackagingUnitApi(conversionId, payload),
    onSuccess: invalidate,
  });
}

export function useDeactivatePackagingUnit() {
  const invalidate = useInvalidateProductUom();
  return useMutation<UomMutationResponse, Error, number>({
    mutationFn: (conversionId) => deactivatePackagingUnitApi(conversionId),
    onSuccess: invalidate,
  });
}
