import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteAliasApi,
  generateBarcodesApi,
  getPrintHistoryApi,
  getVariantBarcodesApi,
  searchBarcodeVariantsApi,
} from "../barcode.api";

/** Query-key factory — same convention as expenses/hardware. */
export const barcodeKeys = {
  all: ["barcodes"] as const,
  search: (filters: BarcodeSearchFilters) =>
    [...barcodeKeys.all, "search", filters] as const,
  variant: (variantId: number) => [...barcodeKeys.all, "variant", variantId] as const,
  printHistory: () => [...barcodeKeys.all, "print-history"] as const,
};

export interface BarcodeSearchFilters {
  search?: string | undefined;
  categoryId?: number | undefined;
  brandId?: number | undefined;
  page: number;
}

export function useBarcodeSearch(filters: BarcodeSearchFilters, enabled = true) {
  return useQuery({
    queryKey: barcodeKeys.search(filters),
    queryFn: () =>
      searchBarcodeVariantsApi({
        search: filters.search,
        categoryId: filters.categoryId,
        brandId: filters.brandId,
        page: filters.page,
        pageSize: 20,
      }),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useVariantBarcodes(variantId: number | null, enabled = true) {
  return useQuery({
    queryKey: barcodeKeys.variant(variantId ?? 0),
    queryFn: () => getVariantBarcodesApi(variantId as number),
    enabled: enabled && variantId !== null,
  });
}

export function useGenerateBarcodes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: generateBarcodesApi,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: barcodeKeys.all });
      // The products catalog carries barcodes too.
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["product"] });
    },
  });
}

export function useDeleteBarcodeAlias() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteAliasApi,
    onSuccess: () => void qc.invalidateQueries({ queryKey: barcodeKeys.all }),
  });
}

export function usePrintHistory(enabled = true) {
  return useQuery({
    queryKey: barcodeKeys.printHistory(),
    queryFn: () => getPrintHistoryApi(50),
    enabled,
  });
}
