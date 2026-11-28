/**
 * Bundle & Combo Phase 2 — pure helpers for the POS bundle UX (offer-strip
 * cards, one-tap add, complete-the-bundle). Side-effect free so the cart
 * math is unit testable; the engine re-prices everything at quote/checkout.
 */

import type { CartType } from "./types/cart.types.js";

export interface PosBundleComponent {
  variantId: number;
  quantity: number;
  productName: string | null;
  sku: string | null;
  sellingPrice: number;
}

export interface PosBundle {
  id: number;
  name: string;
  rule: Record<string, unknown> | null;
  endsAt: string | null;
  components: PosBundleComponent[];
  normalTotal: number;
}

/** Cart quantity per variant in BASE units (packaging lines converted). */
export function cartQuantityByVariant(cart: CartType[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of cart) {
    const variantId = line.variants[0]?.id;
    if (variantId == null) continue;
    const factor = line.conversionFactor ?? 1;
    map.set(variantId, (map.get(variantId) ?? 0) + line.quantity * factor);
  }
  return map;
}

export function componentLabel(component: PosBundleComponent): string {
  return component.productName ?? component.sku ?? `Variant ${component.variantId}`;
}

/** Per-component shortfall between the bundle requirement and the cart. */
export function missingForBundle(
  bundle: PosBundle,
  quantities: Map<number, number>,
): { variantId: number; name: string; missing: number }[] {
  return bundle.components
    .map((c) => ({
      variantId: c.variantId,
      name: componentLabel(c),
      missing: Math.max(0, c.quantity - (quantities.get(c.variantId) ?? 0)),
    }))
    .filter((m) => m.missing > 1e-9);
}

/** The customer's saving per complete bundle at current prices. */
export function bundleSavings(bundle: PosBundle): number | null {
  const price = bundle.rule?.bundlePrice;
  if (typeof price === "number" && price > 0) {
    return Math.max(0, bundle.normalTotal - price);
  }
  const percent = bundle.rule?.discountPercent;
  if (typeof percent === "number" && percent > 0) {
    return bundle.normalTotal * (Math.min(100, percent) / 100);
  }
  return null;
}

export interface QuickAddBlock {
  variantId: number;
  name: string;
  reason: "not-in-catalog" | "serial-tracked";
}

/**
 * A bundle is one-tap addable when the catalog resolves EVERY component and
 * none is serial-tracked (serials need explicit selection). Batch-tracked
 * components are fine — FEFO applies at checkout.
 */
export function quickAddBlocks(
  bundle: PosBundle,
  productByVariantId: Map<
    number,
    { trackingType?: string | null; name: string } | undefined
  >,
): QuickAddBlock[] {
  const blocks: QuickAddBlock[] = [];
  for (const component of bundle.components) {
    const product = productByVariantId.get(component.variantId);
    if (!product) {
      blocks.push({
        variantId: component.variantId,
        name: componentLabel(component),
        reason: "not-in-catalog",
      });
    } else if (product.trackingType === "serial") {
      blocks.push({
        variantId: component.variantId,
        name: product.name,
        reason: "serial-tracked",
      });
    }
  }
  return blocks;
}
