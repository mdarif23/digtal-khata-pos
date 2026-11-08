import api from "@/api/axios";
import type {
  ApplyPriceResult,
  BulkResult,
  CustomerGroup,
  EffectivePricing,
  GroupPricingRow,
  GroupProfitabilityRow,
  Paginated,
  PriceHistoryRow,
  PriceProposal,
  PricingPreviewRow,
  PricingRule,
  PricingRuleInput,
  PricingSettings,
  Promotion,
  PromotionInput,
  PromotionPerformanceRow,
} from "./pricing.types";

/**
 * Pricing API layer — one function per backend endpoint (/api/pricing/*).
 * The shared axios instance carries Authorization, X-Business-Id and
 * X-Location-Id; responses unwrap the {success, data} envelope. NOTE: use
 * this shared instance, NOT bare axios (see finance.api.ts caveat).
 */

interface Envelope<T> {
  success: boolean;
  data: T;
}

// --- Settings ---------------------------------------------------------------

export async function getPricingSettingsApi(): Promise<PricingSettings> {
  const res = await api.get<Envelope<PricingSettings>>("/pricing/settings");
  return res.data.data;
}

export async function updatePricingSettingsApi(
  payload: Partial<Omit<PricingSettings, "updatedAt">>,
): Promise<PricingSettings> {
  const res = await api.put<Envelope<PricingSettings>>("/pricing/settings", payload);
  return res.data.data;
}

// --- Rules -------------------------------------------------------------------

export async function listRulesApi(): Promise<PricingRule[]> {
  const res = await api.get<Envelope<PricingRule[]>>("/pricing/rules");
  return res.data.data;
}

export async function createRuleApi(payload: PricingRuleInput): Promise<PricingRule> {
  const res = await api.post<Envelope<PricingRule>>("/pricing/rules", payload);
  return res.data.data;
}

export async function updateRuleApi(
  id: number,
  payload: Partial<PricingRuleInput>,
): Promise<PricingRule> {
  const res = await api.patch<Envelope<PricingRule>>(`/pricing/rules/${id}`, payload);
  return res.data.data;
}

export async function deleteRuleApi(id: number): Promise<void> {
  await api.delete(`/pricing/rules/${id}`);
}

// --- Preview / effective pricing / materialization ----------------------------

export async function previewPricingApi(
  variantIds: number[],
  whatIf?: { method: "fixed" | "markup" | "margin"; percentage?: number | null; fixedPrice?: number | null },
): Promise<PricingPreviewRow[]> {
  const res = await api.post<Envelope<PricingPreviewRow[]>>("/pricing/preview", {
    variantIds,
    ...(whatIf ?? {}),
  });
  return res.data.data;
}

export async function getEffectivePricingApi(variantId: number): Promise<EffectivePricing> {
  const res = await api.get<Envelope<EffectivePricing>>(
    `/pricing/products/${variantId}/price`,
  );
  return res.data.data;
}

export async function applyPriceApi(
  variantId: number,
  reason?: string,
): Promise<ApplyPriceResult> {
  const res = await api.put<Envelope<ApplyPriceResult>>(
    `/pricing/products/${variantId}/price`,
    { ...(reason ? { reason } : {}) },
  );
  return res.data.data;
}

// --- History -------------------------------------------------------------------

export async function listPriceHistoryApi(params: {
  variantId?: number;
  page?: number;
  pageSize?: number;
}): Promise<Paginated<PriceHistoryRow>> {
  const res = await api.get<{ success: boolean; rows: PriceHistoryRow[]; meta: Paginated<PriceHistoryRow>["meta"] }>(
    "/pricing/history",
    { params },
  );
  return { rows: res.data.rows, meta: res.data.meta };
}

// --- Promotions (Phase 5) -----------------------------------------------------

export async function listPromotionsApi(): Promise<Promotion[]> {
  const res = await api.get<Envelope<Promotion[]>>("/promotions");
  return res.data.data;
}

export async function createPromotionApi(payload: PromotionInput): Promise<Promotion> {
  const res = await api.post<Envelope<Promotion>>("/promotions", payload);
  return res.data.data;
}

export async function updatePromotionApi(
  id: number,
  payload: Partial<PromotionInput>,
): Promise<Promotion> {
  const res = await api.patch<Envelope<Promotion>>(`/promotions/${id}`, payload);
  return res.data.data;
}

export async function deletePromotionApi(id: number): Promise<void> {
  await api.delete(`/promotions/${id}`);
}

// --- Customer groups (Phase 4 endpoints, Phase 5-6 UI) --------------------------

export async function listCustomerGroupsApi(): Promise<CustomerGroup[]> {
  const res = await api.get<Envelope<CustomerGroup[]>>("/customer-groups");
  return res.data.data;
}

export async function createCustomerGroupApi(payload: {
  name: string;
  description?: string | null;
  isDefault?: boolean;
}): Promise<CustomerGroup> {
  const res = await api.post<Envelope<CustomerGroup>>("/customer-groups", payload);
  return res.data.data;
}

export async function updateCustomerGroupApi(
  id: number,
  payload: { name?: string; description?: string | null; isDefault?: boolean; isActive?: boolean },
): Promise<CustomerGroup> {
  const res = await api.patch<Envelope<CustomerGroup>>(`/customer-groups/${id}`, payload);
  return res.data.data;
}

export async function deleteCustomerGroupApi(id: number): Promise<void> {
  await api.delete(`/customer-groups/${id}`);
}

export async function assignGroupMembersApi(
  groupId: number,
  customerIds: number[],
): Promise<{ assigned: number }> {
  const res = await api.put<Envelope<{ assigned: number }>>(
    `/customer-groups/${groupId}/members`,
    { customerIds },
  );
  return res.data.data;
}

export async function listGroupMembersApi(groupId: number) {
  const res = await api.get<Envelope<{ id: number; name: string; phone: string | null }[]>>(
    `/customer-groups/${groupId}/members`,
  );
  return res.data.data;
}

export async function removeGroupMemberApi(
  groupId: number,
  customerId: number,
): Promise<void> {
  await api.delete(`/customer-groups/${groupId}/members/${customerId}`);
}

export async function listGroupPricingApi(groupId: number): Promise<GroupPricingRow[]> {
  const res = await api.get<Envelope<GroupPricingRow[]>>(`/customer-groups/${groupId}/pricing`);
  return res.data.data;
}

export async function createGroupPricingApi(
  groupId: number,
  payload: Partial<PromotionInput> & {
    discountType: "percentage" | "fixed";
    discountValue: number;
  },
): Promise<GroupPricingRow> {
  const res = await api.post<Envelope<GroupPricingRow>>(
    `/customer-groups/${groupId}/pricing`,
    payload,
  );
  return res.data.data;
}

export async function updateGroupPricingApi(
  groupId: number,
  pricingId: number,
  payload: Record<string, unknown>,
): Promise<GroupPricingRow> {
  const res = await api.patch<Envelope<GroupPricingRow>>(
    `/customer-groups/${groupId}/pricing/${pricingId}`,
    payload,
  );
  return res.data.data;
}

export async function deleteGroupPricingApi(
  groupId: number,
  pricingId: number,
): Promise<void> {
  await api.delete(`/customer-groups/${groupId}/pricing/${pricingId}`);
}

// --- Bulk + proposals + auto-update (Phase 8) -----------------------------------

export async function bulkUpdateApi(payload: {
  dryRun: boolean;
  variantIds?: number[];
  categoryIds?: number[];
  productIds?: number[];
  search?: string;
  reason?: string;
}): Promise<BulkResult> {
  const res = await api.post<Envelope<BulkResult>>("/pricing/bulk", payload);
  return res.data.data;
}

export async function listProposalsApi(params: {
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<Paginated<PriceProposal>> {
  const res = await api.get<{ success: boolean; rows: PriceProposal[]; meta: Paginated<PriceProposal>["meta"] }>(
    "/pricing/proposals",
    { params },
  );
  return { rows: res.data.rows, meta: res.data.meta };
}

export async function generateProposalsApi(): Promise<{
  batchToken: string;
  created: number;
  staled: number;
  unchanged: number;
}> {
  const res = await api.post<Envelope<{ batchToken: string; created: number; staled: number; unchanged: number }>>(
    "/pricing/proposals/generate",
  );
  return res.data.data;
}

export async function decideProposalApi(
  id: number,
  decision: "approve" | "reject",
): Promise<PriceProposal> {
  const res = await api.post<Envelope<PriceProposal>>(
    `/pricing/proposals/${id}/${decision}`,
  );
  return res.data.data;
}

export async function bulkApproveProposalsApi(ids: number[]): Promise<{
  applied: number[];
  failed: { id: number; error: string }[];
}> {
  const res = await api.post<Envelope<{ applied: number[]; failed: { id: number; error: string }[] }>>(
    "/pricing/proposals/bulk-approve",
    { ids },
  );
  return res.data.data;
}

export async function runAutoUpdateApi(): Promise<{
  applied: number;
  skipped: number;
  blocked: { variantId: number; reason: string }[];
  unchanged: number;
}> {
  const res = await api.post<Envelope<{ applied: number; skipped: number; blocked: { variantId: number; reason: string }[]; unchanged: number }>>(
    "/pricing/auto-update/run",
  );
  return res.data.data;
}

// --- Pricing reports (Phase 7) ---------------------------------------------------

export async function groupProfitabilityApi(params: {
  period?: string;
  startDate?: string;
  endDate?: string;
}): Promise<{ rows: GroupProfitabilityRow[] }> {
  const res = await api.get<Envelope<{ rows: GroupProfitabilityRow[] }>>(
    "/reports/pricing/group-profitability",
    { params },
  );
  return res.data.data;
}

export async function promotionPerformanceApi(params: {
  period?: string;
  startDate?: string;
  endDate?: string;
}): Promise<{ rows: PromotionPerformanceRow[] }> {
  const res = await api.get<Envelope<{ rows: PromotionPerformanceRow[] }>>(
    "/reports/pricing/promotion-performance",
    { params },
  );
  return res.data.data;
}
