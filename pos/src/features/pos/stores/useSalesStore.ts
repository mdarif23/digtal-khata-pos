import { create } from "zustand";
import { queryClient } from "@/lib/queryClient";
import { productKeys } from "@/features/products/hooks/useProducts.js";
import {
  clearSellUnitsCache,
  sellUnitsKeys,
} from "../hooks/useSellUnits.js";
import { saleKeys } from "../hooks/useSales.js";
import {
  createFullReturnApi,
  createSaleApi,
  createSingleReturnApi,
  getSalesApi,
} from "../sales.api.js";
import { SalesStore } from "../types/sales.types.js";
import type { SaleRefundRequest } from "../types/sales.types.js";

/**
 * The sales LIST moved to TanStack Query (useSalesQuery) in Phase 6 Feature
 * 1. This store keeps the checkout/refund ACTIONS; their list refreshes now
 * invalidate the query cache instead of re-fetching into a Zustand array.
 */

/**
 * Sales-list refresh, preserving the old per-action semantics exactly:
 * createSale's refresh was best-effort (never threw), while the refund
 * actions let a failed list refresh REJECT (the caller surfaced it) even
 * though the refund itself had already succeeded.
 */
async function refreshSalesListStrict(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: saleKeys.list() });
}

/**
 * After any stock-touching transaction (sale, refund, offline replay):
 * refresh the product grid, drop the sell-units promise cache, and
 * invalidate sell-unit queries so package availability ("N left") never
 * stays frozen until a reload.
 */
export async function refreshStockAfterTransaction(): Promise<void> {
  try {
    await queryClient.invalidateQueries({ queryKey: productKeys.catalog() });
  } catch {
    // Stock refresh is best-effort; the transaction itself already succeeded.
  }
  clearSellUnitsCache();
  void queryClient.invalidateQueries({ queryKey: sellUnitsKeys.all });
}

export const useSalesStore = create<SalesStore>(() => ({
  createSale: async (data) => {
    const response = await createSaleApi(data);
    // Refresh the sales history and product stock so the new invoice and the
    // decremented stock are visible immediately (they previously only
    // appeared after a manual refresh — the cashier could oversell believing
    // the stale stock numbers).
    await queryClient
      .invalidateQueries({ queryKey: saleKeys.list() })
      .catch(() => undefined);
    await refreshStockAfterTransaction();
    return response.data;
  },
  returnSingleItems: async (item, options: SaleRefundRequest) => {
    await createSingleReturnApi(item, options);
    await refreshSalesListStrict();
    await refreshStockAfterTransaction();
  },
  returnProducts: async (id, options: SaleRefundRequest) => {
    await createFullReturnApi(id, options);
    await refreshSalesListStrict();
    await refreshStockAfterTransaction();
  },
}));
