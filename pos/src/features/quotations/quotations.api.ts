import api from "../../api/axios.js";

export type QuotationStatus =
  | "draft"
  | "sent"
  | "accepted"
  | "rejected"
  | "expired"
  | "converted"
  | "cancelled";

export interface QuotationRow {
  id: number;
  quoteNumber: string;
  status: QuotationStatus;
  customerId: number | null;
  customerNameSnapshot: string | null;
  subtotal: string;
  discountTotal: string;
  vatTotal: string;
  grandTotal: string;
  vatPercent: string;
  notes: string | null;
  terms: string | null;
  validUntil: string | null;
  convertedSaleId: number | null;
  createdAt: string;
}

export interface QuotationItemRow {
  id: number;
  variantId: number;
  variantNameSnapshot: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  lineTotal: string;
}

export interface QuotationDetail extends QuotationRow {
  items: QuotationItemRow[];
}

export async function listQuotationsApi(filters: {
  status?: QuotationStatus;
  search?: string;
}): Promise<{ rows: QuotationRow[]; total: number }> {
  const res = await api.get<{
    success: boolean;
    data: { rows: QuotationRow[]; total: number };
  }>("/quotations", {
    params: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.search ? { search: filters.search } : {}),
    },
  });
  return res.data.data;
}

export async function getQuotationApi(id: number): Promise<QuotationDetail> {
  const res = await api.get<{ success: boolean; data: QuotationDetail }>(
    `/quotations/${id}`,
  );
  return res.data.data;
}

export async function transitionQuotationApi(
  id: number,
  status: "sent" | "accepted" | "rejected" | "cancelled",
): Promise<void> {
  await api.post(`/quotations/${id}/status`, { status });
}

export async function convertQuotationApi(
  id: number,
  payments: { method: string; amount: number; tendered?: number }[],
): Promise<{ saleId: number; quoteNumber: string }> {
  const res = await api.post<{
    success: boolean;
    data: { saleId: number; quoteNumber: string };
  }>(`/quotations/${id}/convert`, { payments });
  return res.data.data;
}
