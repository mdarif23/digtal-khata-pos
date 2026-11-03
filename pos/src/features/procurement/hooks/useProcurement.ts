import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  convertSuggestionsApi,
  createObservationApi,
  deleteObservationApi,
  getAlertSettingsApi,
  getPriceOverviewApi,
  getReorderDashboardApi,
  getSupplierDetailApi,
  getSupplierPriceHistoryApi,
  getSupplierVariantTrendApi,
  getVariantPriceHistoryApi,
  listObservationsApi,
  updateAlertSettingsApi,
  updateObservationApi,
  type AlertSettings,
  type ConvertSuggestionsInput,
  type CreateObservationInput,
  type PriceCheckFilters,
  type PriceHistoryFilters,
  type PriceOverviewFilters,
  type ReorderDashboardFilters,
  type SupplierHistoryFilters,
  type UpdateObservationInput,
} from "../api/procurement.api";

/** Query-key factory — follow the due-management convention. */
export const procurementKeys = {
  all: ["procurement"] as const,
  priceOverview: (filters: PriceOverviewFilters) =>
    [...procurementKeys.all, "price-overview", filters] as const,
  variantPriceHistory: (variantId: number, filters: PriceHistoryFilters) =>
    [...procurementKeys.all, "variant-price-history", variantId, filters] as const,
  priceCheck: (filters: PriceCheckFilters) =>
    [...procurementKeys.all, "price-check", filters] as const,
  supplierDetail: (supplierId: number) =>
    [...procurementKeys.all, "supplier-detail", supplierId] as const,
  supplierPriceHistory: (supplierId: number, filters: SupplierHistoryFilters) =>
    [...procurementKeys.all, "supplier-price-history", supplierId, filters] as const,
  supplierVariantTrend: (supplierId: number, variantId: number) =>
    [...procurementKeys.all, "supplier-variant-trend", supplierId, variantId] as const,
  alertSettings: () => [...procurementKeys.all, "alert-settings"] as const,
  reorderDashboard: (filters: ReorderDashboardFilters) =>
    [...procurementKeys.all, "reorder-dashboard", filters] as const,
};

export function usePriceOverview(filters: PriceOverviewFilters) {
  return useQuery({
    queryKey: procurementKeys.priceOverview(filters),
    queryFn: () => getPriceOverviewApi(filters),
    placeholderData: keepPreviousData,
  });
}

export function useVariantPriceHistory(
  variantId: number,
  filters: PriceHistoryFilters,
) {
  return useQuery({
    queryKey: procurementKeys.variantPriceHistory(variantId, filters),
    queryFn: () => getVariantPriceHistoryApi(variantId, filters),
    enabled: variantId > 0,
    placeholderData: keepPreviousData,
  });
}

export function usePriceCheckObservations(filters: PriceCheckFilters) {
  return useQuery({
    queryKey: procurementKeys.priceCheck(filters),
    queryFn: () => listObservationsApi(filters),
    placeholderData: keepPreviousData,
  });
}

function useInvalidateProcurement() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: procurementKeys.all });
  };
}

export function useCreateObservation() {
  const invalidate = useInvalidateProcurement();
  return useMutation({
    mutationFn: (payload: CreateObservationInput) => createObservationApi(payload),
    onSuccess: invalidate,
  });
}

export function useUpdateObservation() {
  const invalidate = useInvalidateProcurement();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: number;
      payload: UpdateObservationInput;
    }) => updateObservationApi(id, payload),
    onSuccess: invalidate,
  });
}

export function useDeleteObservation() {
  const invalidate = useInvalidateProcurement();
  return useMutation({
    mutationFn: (id: number) => deleteObservationApi(id),
    onSuccess: invalidate,
  });
}

export function useSupplierDetail(supplierId: number) {
  return useQuery({
    queryKey: procurementKeys.supplierDetail(supplierId),
    queryFn: () => getSupplierDetailApi(supplierId),
    enabled: supplierId > 0,
  });
}

export function useSupplierPriceHistory(
  supplierId: number,
  filters: SupplierHistoryFilters,
) {
  return useQuery({
    queryKey: procurementKeys.supplierPriceHistory(supplierId, filters),
    queryFn: () => getSupplierPriceHistoryApi(supplierId, filters),
    enabled: supplierId > 0,
    placeholderData: keepPreviousData,
  });
}

export function useSupplierVariantTrend(supplierId: number, variantId: number) {
  return useQuery({
    queryKey: procurementKeys.supplierVariantTrend(supplierId, variantId),
    queryFn: () => getSupplierVariantTrendApi(supplierId, variantId),
    enabled: supplierId > 0 && variantId > 0,
  });
}

export function useAlertSettings() {
  return useQuery({
    queryKey: procurementKeys.alertSettings(),
    queryFn: getAlertSettingsApi,
  });
}

export function useUpdateAlertSettings() {
  const invalidate = useInvalidateProcurement();
  return useMutation({
    mutationFn: (payload: AlertSettings) => updateAlertSettingsApi(payload),
    onSuccess: invalidate,
  });
}

export function useReorderDashboard(filters: ReorderDashboardFilters) {
  return useQuery({
    queryKey: procurementKeys.reorderDashboard(filters),
    queryFn: () => getReorderDashboardApi(filters),
    placeholderData: keepPreviousData,
  });
}

export function useConvertSuggestions() {
  const invalidate = useInvalidateProcurement();
  return useMutation({
    mutationFn: (payload: ConvertSuggestionsInput) =>
      convertSuggestionsApi(payload),
    onSuccess: invalidate,
  });
}
