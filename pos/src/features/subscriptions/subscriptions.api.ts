import api from "@/api/axios";

export interface BusinessSubscriptionSummary {
  planName: string;
  status: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

export async function getCurrentBusinessSubscriptionApi(
  businessId: number,
): Promise<BusinessSubscriptionSummary | null> {
  const { data } = await api.get<{
    data: BusinessSubscriptionSummary | null;
  }>(`/businesses/${businessId}/subscription/open`);
  return data.data;
}
