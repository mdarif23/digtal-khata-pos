import api from "@/api/axios";
import type {
  ApplyPriceResult,
  EffectivePricing,
  Paginated,
  PricingPreviewRow,
  PricingRule,
  PricingRuleInput,
  PricingSettings,
  PriceHistoryRow,
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
