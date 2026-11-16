import { useEffect } from "react";
import {
  saleKeys,
} from "@/features/pos/hooks/useSales.js";
import { getSalesApi } from "@/features/pos/sales.api.js";
import {
  fetchProductSelectOptions,
  fetchProductVariantOptions,
} from "@/features/products/hooks/useProductOptions.js";
import { usePurchasesStore } from "@/features/purchases/usePurchaseStore";
import { getActiveBusinessId, getActiveLocationId, getSessionUser } from "@/api/axios";
import { useHoldCartStore } from "@/features/pos/stores/useCartStore";
import { useReceiptSettingsStore } from "@/features/pos/stores/useReceiptSettingsStore";
import { queryClient } from "@/lib/queryClient.js";
import {
  customerKeys,
  fetchCustomersWithOfflineCache,
} from "@/features/customers/hooks/useCustomers.js";
import {
  productKeys,
  fetchProductsWithOfflineCache,
} from "@/features/products/hooks/useProducts.js";

const LAST_SESSION_KEY = "ezpos-last-session";

/**
 * POS terminals are shared. Held carts and receipt settings are persisted in
 * localStorage with global keys, so before the app renders we check whether
 * the previous localStorage session belonged to a different user/business
 * and clear them — otherwise the next cashier can list, restore, or destroy
 * the previous cashier's held basket.
 */
function enforceSessionScope(): void {
  const user = getSessionUser();
  const businessId = getActiveBusinessId();
  const locationId = getActiveLocationId();
  // Held carts are location-specific: switching stores must not leak carts
  // across locations of the same user.
  const currentScope =
    (user?.id != null ? `u${user.id}` : `b${businessId}`) +
    (locationId !== null ? `l${locationId}` : "");
  let previousScope: string | null = null;
  try {
    previousScope = localStorage.getItem(LAST_SESSION_KEY);
    localStorage.setItem(LAST_SESSION_KEY, currentScope);
  } catch {
    return; // localStorage unavailable — nothing persisted, nothing to leak.
  }
  if (previousScope !== null && previousScope !== currentScope) {
    useHoldCartStore.getState().clearHoldCarts();
    useReceiptSettingsStore.getState().resetSettings();
  }
}

// `enabled` gates the startup data fetches on the session bootstrap: firing
// them without a restored token produces doomed 401s and redirect cascades.
export function useInitializeApp(enabled: boolean) {
  const { getPurchases, getPurchaseItems, getPurchasesReturnItems } =
    usePurchasesStore();
  useEffect(() => {
    if (!enabled) return;
    enforceSessionScope();
    // Products + customers + sales lists: TanStack Query warm-starts (same
    // fetch the old store actions performed, same order position).
    void queryClient.prefetchQuery({
      queryKey: productKeys.catalog(),
      queryFn: fetchProductsWithOfflineCache,
    });
    void queryClient.prefetchQuery({
      queryKey: customerKeys.list(),
      queryFn: fetchCustomersWithOfflineCache,
    });
    void queryClient.prefetchQuery({
      queryKey: productKeys.selectOptions(),
      queryFn: fetchProductSelectOptions,
    });
    void queryClient.prefetchQuery({
      queryKey: productKeys.variantOptions(),
      queryFn: fetchProductVariantOptions,
    });
    void queryClient.prefetchQuery({
      queryKey: saleKeys.list(),
      queryFn: getSalesApi,
    });
    getPurchases();
    getPurchaseItems();
    getPurchasesReturnItems();
  }, [enabled]);
}
