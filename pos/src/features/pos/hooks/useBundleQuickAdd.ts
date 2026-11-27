import { useCallback } from "react";
import { useCartStore } from "../stores/useCartStore.js";
import {
  productCatalogActions,
  readProductsCache,
} from "@/features/products/hooks/useProducts.js";
import { toast } from "@/components/ui/toast";
import {
  cartQuantityByVariant,
  componentLabel,
  missingForBundle,
  quickAddBlocks,
  type PosBundle,
} from "../bundleCart.js";

/**
 * Bundle & Combo Phase 2 — one-tap bundle add shared by the offer-strip
 * cards and the near-miss chips. Semantics: TOP UP the cart to the bundle
 * requirement (a fresh cart receives the full package; a partial cart is
 * completed, never overshoot). Serial-tracked components are refused before
 * any stock is taken (serials need explicit selection); batch-tracked ones
 * ride the normal FEFO path. Client-side stock takes roll back when any
 * component is short, so the catalog cache never drifts.
 */
export function useBundleQuickAdd() {
  const cart = useCartStore((s) => s.cart);

  return useCallback(
    async (bundle: PosBundle): Promise<boolean> => {
      const products = readProductsCache();
      const productByVariantId = new Map(
        products.flatMap((product) =>
          product.variants
            .filter((variant): variant is typeof variant & { id: number } =>
              variant.id != null,
            )
            .map((variant) => [variant.id, product] as const),
        ),
      );
      const blocks = quickAddBlocks(bundle, productByVariantId);
      if (blocks.length > 0) {
        const blocked = blocks[0]!;
        toast.add({
          type: "error",
          description:
            blocked.reason === "serial-tracked"
              ? `${blocked.name}: serial-tracked components need explicit serial selection — add them manually.`
              : `${blocked.name}: not found in the catalog cache.`,
          priority: "high",
        });
        return false;
      }

      const missing = missingForBundle(bundle, cartQuantityByVariant(cart));
      if (missing.length === 0) {
        toast.add({
          type: "info",
          description: `${bundle.name}: the cart already has every component.`,
        });
        return true;
      }

      // Take client-side stock first, rolling back on any shortfall.
      const taken: { variantId: number; quantity: number }[] = [];
      for (const component of missing) {
        const ok = productCatalogActions.tryTakeVariantStock(
          component.variantId,
          component.missing,
        );
        if (!ok) {
          for (const entry of taken) {
            productCatalogActions.returnVariantStock(entry.variantId, entry.quantity);
          }
          const name = productByVariantId.get(component.variantId)?.name ?? component.name;
          toast.add({
            type: "error",
            description: `${name}: not enough stock available for ${bundle.name}.`,
            priority: "high",
          });
          return false;
        }
        taken.push({ variantId: component.variantId, quantity: component.missing });
      }

      const state = useCartStore.getState();
      for (const component of missing) {
        const product = products.find((p) =>
          p.variants.some((v) => v.id === component.variantId),
        );
        if (!product) continue; // quickAddBlocks already rejected this case
        state.addToCart(product, undefined, component.missing);
      }
      toast.add({
        type: "success",
        description: `${bundle.name}: ${missing
          .map((m) => `+${!Number.isInteger(m.missing) ? m.missing.toFixed(3) : m.missing} ${m.name}`)
          .join(", ")}`,
      });
      return true;
    },
    [cart],
  );
}

/** Display helper shared by the cards: "1 Notebook + 2 Pen" style summary. */
export function summarizeComponents(
  bundle: PosBundle,
  max = 3,
): string {
  const parts = bundle.components.slice(0, max).map((c) => {
    const qty = !Number.isInteger(c.quantity) ? c.quantity.toFixed(3) : c.quantity;
    return `${qty} ${componentLabel(c)}`;
  });
  const rest = bundle.components.length - parts.length;
  return parts.join(" + ") + (rest > 0 ? ` + ${rest} more` : "");
}
