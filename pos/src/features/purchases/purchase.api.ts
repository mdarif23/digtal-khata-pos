import axios from "../../api/axios.js";
import type {
  CreatePurchaseInput,
  PurchaseStoreType,
  PurchasesItems,
  PurchasesReturnItems,
} from "./purchase.types.js";
import type { ReceiveItemsFormValues } from "./schemas/receiveItem.schema.js";

// Feature-owned API client for the purchases domain (Phase 5: the split
// global `api/purchases.api.ts` was merged here).

export interface PurchasesSummary {
  orderedPurchase: PurchaseStoreType[];
  partiallyPaidPurchase: PurchaseStoreType[];
  completedPurchase: PurchaseStoreType[];
  allPurchases: PurchaseStoreType[];
}

export async function createPurchaseApi(data: CreatePurchaseInput) {
  return axios.post("/purchases", data);
}
export async function createReceivePurchaseApi(data: ReceiveItemsFormValues) {
  return axios.post("/purchases/receive", data);
}
export async function getPurchasesApi(): Promise<PurchasesSummary> {
  const { data } = await axios.get("/purchases");
  return data;
}
export async function getPurchasesItemsApi(): Promise<PurchasesItems[]> {
  const { data } = await axios.get("/purchases/items");
  return data;
}
export async function getPurchasesReturnItemsApi(): Promise<
  PurchasesReturnItems[]
> {
  const { data } = await axios.get("/purchases/return-items");
  return data;
}
export async function purchaseReturnApi(data: {
  orderId: number;
  reason?: string;
  changedItems: { purchaseItemId: number; quantity: number }[];
}) {
  const response = await axios.post("/purchase-return", data);
  return response.data;
}
