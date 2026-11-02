import axios from "../../api/axios.js";
import type { CreateSalePayload } from "@/features/pos/schemas/cart.schema.js";
import type {
  SalesStoreType,
  CreateSaleResponse,
  SaleRefundRequest,
} from "@/features/pos/types/sales.types.js";
import type { SaleReceiptData } from "./types/receipt.types.js";

export async function getSalesApi(): Promise<SalesStoreType[]> {
  const { data } = await axios.get<SalesStoreType[]>("/sold_products");
  return data;
}

export async function getSaleReceiptApi(saleId: number): Promise<SaleReceiptData> {
  const { data } = await axios.get<SaleReceiptData>(`/sales/${saleId}/receipt`);
  return data;
}

export async function createSaleApi(data: CreateSalePayload) {
  return await axios.post<CreateSaleResponse>("/sales", data);
}

export async function createSingleReturnApi(
  item: SalesStoreType,
  options: SaleRefundRequest,
) {
  return await axios.post(`/sold_products/refund/${item.saleItemsId}`, options);
}

export async function createFullReturnApi(
  id: number,
  options: SaleRefundRequest,
) {
  return await axios.post(`/sold_products/refunds_all/${id}`, options);
}

// --- exchanges (Module 5) ---------------------------------------------------

export interface ExchangePayload {
  returns: { saleItemId: number }[];
  replacements: {
    variantId: number;
    quantity: number;
    discount?: { type: "percentage" | "fixed"; value: number } | null;
  }[];
  additionalPayments?: {
    method: "cash" | "bangla_qr" | "card";
    amount: number;
    reference?: string | null;
    tendered?: number | null;
  }[];
  refundMethod?: "cash" | "original_payment";
  reason:
    | "customer_request"
    | "wrong_item"
    | "damaged"
    | "quality_issue"
    | "other";
  notes?: string;
  disposition: "restock" | "inspection" | "damaged";
  idempotencyKey?: string;
}

export interface ExchangeResponse {
  sale: { id: number; invoiceNumber: string };
  refundId: number;
  refundTotal: number;
  replacementTotal: number;
  difference: number;
  receipt: SaleReceiptData;
  providerPayout: { paid: boolean; status: string; reason?: string } | null;
}

export async function createExchangeApi(saleId: number, payload: ExchangePayload) {
  const res = await axios.post<{ data: ExchangeResponse }>(
    `/sales/${saleId}/exchange`,
    payload,
  );
  return res.data.data;
}

// --- electronic payment intents (due collection via QR / card) --------------

export interface PaymentIntentResponse {
  intentId: number;
  saleId: number;
  status: string;
  amount: number;
  provider: string;
  gatewayUrl: string | null;
  replayed: boolean;
}

export async function createPaymentIntentApi(
  saleId: number,
  payload: {
    provider: "mock" | "sslcommerz";
    method: "bangla_qr" | "card";
    amount: number;
    idempotencyKey: string;
    redirectUrls: { success: string; fail: string; cancel: string };
  },
): Promise<PaymentIntentResponse> {
  const res = await axios.post<{ data: PaymentIntentResponse }>(
    `/sales/${saleId}/payment-intents`,
    payload,
  );
  return res.data.data;
}

export async function verifyPaymentIntentApi(
  intentId: number,
  valId: string,
): Promise<{ verified: boolean; alreadyCaptured: boolean; reason?: string }> {
  const res = await axios.post<{
    success: boolean;
    data: { verified: boolean; alreadyCaptured: boolean; reason?: string };
  }>(`/sales/payment-intents/${intentId}/verify`, { valId });
  return res.data.data;
}

export async function verifyPaymentIntentByTranApi(
  tranId: string,
  valId: string,
): Promise<{ verified: boolean; alreadyCaptured: boolean; reason?: string }> {
  const res = await axios.post<{
    success: boolean;
    data: { verified: boolean; alreadyCaptured: boolean; reason?: string };
  }>(`/sales/payment-intents/verify`, { tranId, valId });
  return res.data.data;
}
