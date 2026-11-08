import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as pricingApi from "../pricing.api";
import type { PricingRuleInput, PricingSettings } from "../pricing.types";

/**
 * TanStack Query hooks for Pricing (key factories per resource; mutations
 * invalidate the `all` root, mirroring the finance hooks).
 */

export const pricingKeys = {
  all: ["pricing"] as const,
  settings: () => [...pricingKeys.all, "settings"] as const,
  rules: () => [...pricingKeys.all, "rules"] as const,
  preview: (variantIds: number[]) =>
    [...pricingKeys.all, "preview", [...variantIds].sort((a, b) => a - b).join(",")] as const,
  effective: (variantId: number) => [...pricingKeys.all, "effective", variantId] as const,
  history: (filters: Record<string, unknown>) =>
    [...pricingKeys.all, "history", filters] as const,
};

export function usePricingSettings() {
  return useQuery({
    queryKey: pricingKeys.settings(),
    queryFn: pricingApi.getPricingSettingsApi,
  });
}

export function useUpdatePricingSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Partial<Omit<PricingSettings, "updatedAt">>) =>
      pricingApi.updatePricingSettingsApi(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: pricingKeys.all });
    },
  });
}

export function usePricingRules() {
  return useQuery({
    queryKey: pricingKeys.rules(),
    queryFn: pricingApi.listRulesApi,
  });
}

export function useCreateRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: PricingRuleInput) => pricingApi.createRuleApi(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: pricingKeys.all });
    },
  });
}

export function useUpdateRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Partial<PricingRuleInput> }) =>
      pricingApi.updateRuleApi(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: pricingKeys.all });
    },
  });
}

export function useDeleteRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => pricingApi.deleteRuleApi(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: pricingKeys.all });
    },
  });
}

export function usePriceHistory(filters: { variantId?: number; page: number; pageSize: number }) {
  return useQuery({
    queryKey: pricingKeys.history(filters as unknown as Record<string, unknown>),
    queryFn: () => pricingApi.listPriceHistoryApi(filters),
  });
}
