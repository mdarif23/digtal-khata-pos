import { create } from "zustand";
import { PurchasesStore } from "./purchase.types.js";
import {
  createPurchaseApi,
  createReceivePurchaseApi,
  getPurchasesApi,
  getPurchasesItemsApi,
  getPurchasesReturnItemsApi,
} from "./purchase.api.js";
import { getErrorMessage } from "@/utils/getErrorMessage.js";
export const usePurchasesStore = create<PurchasesStore>((set) => ({
  purchases: {
    orderedPurchase: [],
    partiallyPaidPurchase: [],
    completedPurchase: [],
    allPurchases: [],
  },
  purchasesItems: [],
  purchasesReturnItems: [],
  loading: false,
  error: null,
  getPurchaseItems: async () => {
    set({ loading: true });
    try {
      const data = await getPurchasesItemsApi();
      set({ purchasesItems: data, loading: false });
    } catch (err: unknown) {
      set({ error: getErrorMessage(err), loading: false });
    }
  },
  getPurchases: async () => {
    set({ loading: true });
    try {
      const data = await getPurchasesApi();
      set({ purchases: data, loading: false });
    } catch (err: unknown) {
      set({ error: getErrorMessage(err), loading: false });
    }
  },
  getPurchasesReturnItems: async () => {
    set({ loading: true });
    try {
      const data = await getPurchasesReturnItemsApi();
      set({ purchasesReturnItems: data, loading: false });
    } catch (err: unknown) {
      set({ error: getErrorMessage(err), loading: false });
    }
  },
  createReceivePurchase: async (data) => {
    const response = await createReceivePurchaseApi(data);
    return response.data;
  },
  createPurchase: async (data) => {
    const response = await createPurchaseApi(data);
    return response.data;
  },
}));
