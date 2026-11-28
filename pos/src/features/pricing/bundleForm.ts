/**
 * Bundle & Combo Phase 1 — pure helpers for the fixed-bundle form
 * (PromotionsPage). Kept side-effect free so the creation rules are unit
 * testable; the backend re-validates every field server-side.
 */

export interface BundleComponentDraft {
  variantId: string;
  quantity: string;
}

export type BundlePriceMode = "price" | "percent";

/** Normal component total at current selling prices (display preview). */
export function bundleNormalTotalOf(
  components: BundleComponentDraft[],
  priceByVariantId: Map<number, number>,
): number {
  return components.reduce((sum, c) => {
    const price = priceByVariantId.get(Number(c.variantId));
    const qty = Number(c.quantity);
    return sum + (price != null && qty > 0 ? price * qty : 0);
  }, 0);
}

/** Component rows ready for the API (valid variant + positive quantity). */
export function bundleComponentPayload(
  components: BundleComponentDraft[],
): { variantId: number; quantity: number }[] {
  return components
    .filter((c) => c.variantId !== "" && Number(c.quantity) > 0)
    .map((c) => ({ variantId: Number(c.variantId), quantity: Number(c.quantity) }));
}

/**
 * H3-1 discipline for bundles: refuse incomplete forms at the door instead
 * of saving a rule the engine silently skips. Returns an error message or
 * null when the form is ready.
 */
export function validateBundleForm(
  components: BundleComponentDraft[],
  mode: BundlePriceMode,
  priceValue: string,
  percentValue: string,
): string | null {
  if (bundleComponentPayload(components).length === 0) {
    return "A bundle needs at least one component with a quantity.";
  }
  if (mode === "price" && !(Number(priceValue) > 0)) {
    return "Set a bundle price greater than zero.";
  }
  const percent = Number(percentValue);
  if (mode === "percent" && !(percent > 0 && percent <= 100)) {
    return "Bundle percent must be between 1 and 100.";
  }
  return null;
}

/** The `rule` jsonb payload: exactly one of bundlePrice | discountPercent. */
export function buildBundleRule(
  mode: BundlePriceMode,
  priceValue: string,
  percentValue: string,
  maxApplications: string,
): Record<string, unknown> {
  const base =
    mode === "price"
      ? { bundlePrice: Number(priceValue) }
      : { discountPercent: Number(percentValue) };
  const maxApps = Number(maxApplications);
  return maxApplications !== "" && maxApps > 0
    ? { ...base, maxApplications: maxApps }
    : base;
}
