import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as pricingApi from "../pricing.api";
import type {
  PricingRuleInput,
  PricingSettings,
  PromotionInput,
} from "../pricing.types";

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

// --- Promotions (Phase 5) -----------------------------------------------------

export const promotionKeys = {
  all: ["promotions"] as const,
};

export function usePromotions() {
  return useQuery({
    queryKey: promotionKeys.all,
    queryFn: pricingApi.listPromotionsApi,
  });
}

export function useCreatePromotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: PromotionInput) => pricingApi.createPromotionApi(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: promotionKeys.all });
    },
  });
}

export function useUpdatePromotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Partial<PromotionInput> }) =>
      pricingApi.updatePromotionApi(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: promotionKeys.all });
    },
  });
}

export function useDeletePromotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => pricingApi.deletePromotionApi(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: promotionKeys.all });
    },
  });
}

// --- Customer groups (Phase 4 endpoints, Phase 5-6 UI) --------------------------

export const customerGroupKeys = {
  all: ["customer-groups"] as const,
  detail: (groupId: number) => [...customerGroupKeys.all, groupId] as const,
};

export function useCustomerGroups() {
  return useQuery({
    queryKey: customerGroupKeys.all,
    queryFn: pricingApi.listCustomerGroupsApi,
  });
}

export function useCreateCustomerGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: pricingApi.createCustomerGroupApi,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: customerGroupKeys.all });
    },
  });
}

export function useUpdateCustomerGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: number;
      payload: Parameters<typeof pricingApi.updateCustomerGroupApi>[1];
    }) => pricingApi.updateCustomerGroupApi(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: customerGroupKeys.all });
    },
  });
}

export function useDeleteCustomerGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => pricingApi.deleteCustomerGroupApi(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: customerGroupKeys.all });
    },
  });
}

export function useGroupPricing(groupId: number | null) {
  return useQuery({
    queryKey: [...customerGroupKeys.detail(groupId ?? 0), "pricing"] as const,
    queryFn: () => pricingApi.listGroupPricingApi(groupId!),
    enabled: groupId != null,
  });
}

export function useCreateGroupPricing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      groupId,
      payload,
    }: {
      groupId: number;
      payload: Parameters<typeof pricingApi.createGroupPricingApi>[1];
    }) => pricingApi.createGroupPricingApi(groupId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: customerGroupKeys.all });
    },
  });
}

export function useDeleteGroupPricing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, pricingId }: { groupId: number; pricingId: number }) =>
      pricingApi.deleteGroupPricingApi(groupId, pricingId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: customerGroupKeys.all });
    },
  });
}

// --- Bulk + proposals + auto-update (Phase 8) -----------------------------------

export function useBulkUpdate() {
  return useMutation({ mutationFn: pricingApi.bulkUpdateApi });
}

export function useProposals(filters: { status?: string; page: number; pageSize: number }) {
  return useQuery({
    queryKey: [...pricingKeys.all, "proposals", filters] as const,
    queryFn: () => pricingApi.listProposalsApi(filters),
  });
}

export function useGenerateProposals() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: pricingApi.generateProposalsApi,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...pricingKeys.all, "proposals"] });
    },
  });
}

export function useDecideProposal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "approve" | "reject" }) =>
      pricingApi.decideProposalApi(id, decision),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...pricingKeys.all, "proposals"] });
      void queryClient.invalidateQueries({ queryKey: pricingKeys.all });
    },
  });
}

export function useBulkApproveProposals() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => pricingApi.bulkApproveProposalsApi(ids),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...pricingKeys.all, "proposals"] });
    },
  });
}

export function useRunAutoUpdate() {
  return useMutation({ mutationFn: pricingApi.runAutoUpdateApi });
}

// --- Pricing reports (Phase 7) ---------------------------------------------------

export function useGroupProfitability(filters: { period: string; startDate?: string; endDate?: string }) {
  return useQuery({
    queryKey: [...pricingKeys.all, "reports", "group-profitability", filters] as const,
    queryFn: () => pricingApi.groupProfitabilityApi(filters),
  });
}

export function usePromotionPerformance(filters: { period: string; startDate?: string; endDate?: string }) {
  return useQuery({
    queryKey: [...pricingKeys.all, "reports", "promotion-performance", filters] as const,
    queryFn: () => pricingApi.promotionPerformanceApi(filters),
  });
}
