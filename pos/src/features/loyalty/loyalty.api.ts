import api from "../../api/axios.js";

export interface LoyaltyProgram {
  earnRate: number;
  redeemValue: number;
  isActive: boolean;
  expiryMode: "none" | "fixed";
  expiryDays: number | null;
  minRedemptionPoints: number;
  maxRedemptionPointsPerSale: number | null;
}

export interface EarnRule {
  isActive: boolean;
  minTransactionAmount: number;
  excludedCategoryIds: number[];
  excludedProductIds: number[];
  bonusPoints: number;
  multiplier: number;
  startsAt: string | null;
  endsAt: string | null;
}

export interface LoyaltyTier {
  id: number;
  name: string;
  minSpend: number;
  qualificationMonths: number | null;
  earnMultiplier: number;
  rank: number;
  isActive: boolean;
}

export async function getLoyaltyProgramApi(): Promise<LoyaltyProgram | null> {
  const res = await api.get<{ success: boolean; data: LoyaltyProgram | null }>(
    "/loyalty/program",
  );
  return res.data.data;
}

export async function putLoyaltyProgramApi(
  program: LoyaltyProgram,
): Promise<LoyaltyProgram> {
  const res = await api.put<{ success: boolean; data: LoyaltyProgram }>(
    "/loyalty/program",
    program,
  );
  return res.data.data;
}

export async function getEarnRuleApi(): Promise<EarnRule> {
  const res = await api.get<{ success: boolean; data: EarnRule }>(
    "/loyalty/earn-rule",
  );
  return res.data.data;
}

export async function putEarnRuleApi(rule: EarnRule): Promise<EarnRule> {
  const res = await api.put<{ success: boolean; data: EarnRule }>(
    "/loyalty/earn-rule",
    rule,
  );
  return res.data.data;
}

export async function getTiersApi(): Promise<LoyaltyTier[]> {
  const res = await api.get<{ success: boolean; data: LoyaltyTier[] }>(
    "/loyalty/tiers",
  );
  return res.data.data;
}

export async function createTierApi(tier: Omit<LoyaltyTier, "id">): Promise<LoyaltyTier> {
  const res = await api.post<{ success: boolean; data: LoyaltyTier }>(
    "/loyalty/tiers",
    tier,
  );
  return res.data.data;
}

export async function updateTierApi(
  id: number,
  tier: Omit<LoyaltyTier, "id">,
): Promise<LoyaltyTier> {
  const res = await api.put<{ success: boolean; data: LoyaltyTier }>(
    `/loyalty/tiers/${id}`,
    tier,
  );
  return res.data.data;
}

export async function deleteTierApi(id: number): Promise<void> {
  await api.delete(`/loyalty/tiers/${id}`);
}
