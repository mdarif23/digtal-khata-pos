import api from "../../api/axios.js";

export interface CommissionRule {
  id: number;
  name: string;
  calcMethod: "percentage_of_sales" | "fixed_per_sale" | "percentage_of_profit";
  rate: number;
  categoryId: number | null;
  productId: number | null;
  userId: number | null;
  isActive: boolean;
}

export interface CommissionEntryRow {
  id: number;
  saleId: number;
  salespersonUserId: number;
  salespersonName: string;
  ruleName: string;
  calcMethod: string;
  baseAmount: string;
  amount: string;
  status: "calculated" | "pending" | "approved" | "payable" | "paid" | "reversed";
  refundId: number | null;
  reason: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface CommissionTotals {
  pending: number;
  approved: number;
  paid: number;
  reversed: number;
}

export interface SalesTargetRow {
  id: number;
  userId: number;
  userName: string;
  periodType: string;
  periodStart: string;
  periodEnd: string;
  targetAmount: string;
}

export interface TargetAchievement {
  userId: number;
  userName: string;
  targetAmount: number;
  actualAmount: number;
  achievementPercent: number | null;
  periodStart: string;
  periodEnd: string;
  periodType: string;
}

export interface SalespersonPerformanceRow {
  userId: number;
  userName: string;
  salesCount: string;
  netSales: string;
  commissionEarned: string;
}

export async function listRulesApi(): Promise<CommissionRule[]> {
  const res = await api.get<{ success: boolean; data: CommissionRule[] }>(
    "/commission/rules",
  );
  return res.data.data;
}

export async function createRuleApi(input: {
  name: string;
  calcMethod: string;
  rate: number;
  userId: number | null;
  isActive: boolean;
}): Promise<CommissionRule> {
  const res = await api.post<{ success: boolean; data: CommissionRule }>(
    "/commission/rules",
    input,
  );
  return res.data.data;
}

export async function updateRuleApi(
  id: number,
  patch: { isActive?: boolean; rate?: number },
): Promise<void> {
  await api.patch(`/commission/rules/${id}`, patch);
}

export async function listEntriesApi(filters: {
  status?: string;
}): Promise<{ rows: CommissionEntryRow[]; totals: CommissionTotals }> {
  const res = await api.get<{
    success: boolean;
    data: { rows: CommissionEntryRow[]; totals: CommissionTotals };
  }>("/commission/entries", {
    params: { ...(filters.status ? { status: filters.status } : {}) },
  });
  return res.data.data;
}

export async function transitionEntryApi(
  id: number,
  status: "approved" | "payable" | "paid" | "reversed",
  reason?: string,
): Promise<void> {
  await api.post(`/commission/entries/${id}/status`, {
    status,
    ...(reason ? { reason } : {}),
  });
}

export async function listTargetsApi(): Promise<SalesTargetRow[]> {
  const res = await api.get<{ success: boolean; data: SalesTargetRow[] }>(
    "/targets",
  );
  return res.data.data;
}

export async function setTargetApi(input: {
  userId: number;
  periodType: string;
  periodStart: string;
  periodEnd: string;
  targetAmount: number;
}): Promise<void> {
  await api.put("/targets", input);
}

export async function getAchievementsApi(): Promise<TargetAchievement[]> {
  const res = await api.get<{ success: boolean; data: TargetAchievement[] }>(
    "/targets/achievement",
  );
  return res.data.data;
}

export async function getPerformanceApi(
  from: string,
  to: string,
): Promise<SalespersonPerformanceRow[]> {
  const res = await api.get<{ success: boolean; data: SalespersonPerformanceRow[] }>(
    "/commission/performance",
    { params: { from, to } },
  );
  return res.data.data;
}
