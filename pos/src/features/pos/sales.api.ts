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
