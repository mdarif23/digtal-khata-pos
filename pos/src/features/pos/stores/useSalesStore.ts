import { create } from "zustand";
import { getErrorMessage } from "../../../utils/getErrorMessage.js";
import { queryClient } from "@/lib/queryClient";
import useProductStore from "@/features/products/useProductStore";
import {
  clearSellUnitsCache,
  sellUnitsKeys,
} from "../hooks/useSellUnits.js";
import {
  createFullReturnApi,
  createSaleApi,
  createSingleReturnApi,
  getSalesApi,
} from "../sales.api.js";
import { SalesStore } from "../types/sales.types.js";
import type { SaleRefundRequest } from "../types/sales.types.js";

/**
 * After any stock-touching transaction (sale, refund, offline replay):
 * refresh the product grid, drop the sell-units promise cache, and
 * invalidate sell-unit queries so package availability ("N left") never
 * stays frozen until a reload.
 */
export async function refreshStockAfterTransaction(): Promise<void> {
  try {
    await useProductStore.getState().getProducts();
  } catch {
    // Stock refresh is best-effort; the transaction itself already succeeded.
  }
  clearSellUnitsCache();
  void queryClient.invalidateQueries({ queryKey: sellUnitsKeys.all });
}

export const useSalesStore = create<SalesStore>((set) => ({
  sales: [],
  loading: false,
  error: null,
  getSales: async () => {
    set({ loading: true, error: null });
    try {
      const data = await getSalesApi();
      set({ sales: data });
    } catch (err: unknown) {
      set({ error: getErrorMessage(err) });
    } finally {
      set({ loading: false });
    }
  },
  createSale: async (data) => {
    const response = await createSaleApi(data);
    // Refresh the sales history and product stock so the new invoice and the
    // decremented stock are visible immediately (they previously only
    // appeared after a manual refresh — the cashier could oversell believing
    // the stale stock numbers).
    const sales = await getSalesApi().catch(() => undefined);
    if (sales) set({ sales });
    await refreshStockAfterTransaction();
    return response.data;
  },
  returnSingleItems: async (item, options: SaleRefundRequest) => {
    await createSingleReturnApi(item, options);
    set({ sales: await getSalesApi(), error: null });
    await refreshStockAfterTransaction();
  },
  returnProducts: async (id, options: SaleRefundRequest) => {
    await createFullReturnApi(id, options);
    set({ sales: await getSalesApi(), error: null });
    await refreshStockAfterTransaction();
  },
}));
