import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createObservationApi,
  deleteObservationApi,
  getPriceOverviewApi,
  getVariantPriceHistoryApi,
  listObservationsApi,
  updateObservationApi,
  type CreateObservationInput,
  type PriceCheckFilters,
  type PriceHistoryFilters,
  type PriceOverviewFilters,
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
