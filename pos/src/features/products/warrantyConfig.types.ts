/**
 * Frontend mirror of the backend product/variant warranty configuration
 * contract (ezPosBackend src/modules/warranty/warranty.schemas.ts +
 * warrantyConfig.service.ts). Kept in sync by hand — the two apps do not
 * share code. The backend remains the validation authority.
 */

export const WARRANTY_PROVIDERS = [
  "manufacturer",
  "seller",
  "distributor",
  "supplier",
  "third_party",
] as const;
export const WARRANTY_TYPES = [
  "repair",
  "replacement",
  "service",
  "limited",
  "parts_only",
  "comprehensive",
] as const;
export const WARRANTY_DURATION_UNITS = ["days", "months", "years"] as const;

export type WarrantyProvider = (typeof WARRANTY_PROVIDERS)[number];
export type WarrantyType = (typeof WARRANTY_TYPES)[number];
export type WarrantyDurationUnit = (typeof WARRANTY_DURATION_UNITS)[number];

/** PUT /api/products/:productId/warranty-config body (same for variants). */
export interface WarrantyConfigWrite {
  enabled: boolean;
  provider: WarrantyProvider;
  warrantyType: WarrantyType;
  /** Whole number, > 0, max 360 (backend-validated). */
  duration: number;
  durationUnit: WarrantyDurationUnit;
  terms: string | null;
}

/** A saved config row (product default or variant override). */
export interface StoredWarrantyConfig extends WarrantyConfigWrite {
  id: number;
  status: string;
}

/**
 * The config that actually applies to a variant (variant override, else the
 * product default), or null when the variant has no warranty.
 */
export type EffectiveWarrantyConfig = WarrantyConfigWrite;

export interface VariantWarrantyView {
  variantId: number;
  variantName: string;
  /** The effective config, or null when the variant has no warranty. */
  effective: EffectiveWarrantyConfig | null;
  /** null = inherits the product default; a row = variant override. */
  override: StoredWarrantyConfig | null;
}

/** GET /api/products/:productId/warranty-config response `data`. */
export interface ProductWarrantyConfigView {
  productId: number;
  productName: string;
  hasVariants: boolean | null;
  trackingType: string | null;
  productDefault: StoredWarrantyConfig | null;
  variants: VariantWarrantyView[];
}

/** Mutation response wrapper: { success: true, data }. */
export interface WarrantyConfigMutationResponse {
  success: boolean;
  data: StoredWarrantyConfig;
}

export interface RemoveVariantWarrantyResponse {
  success: boolean;
  data: unknown;
}

/** "12 Months" / "30 Days" / "2 Years" — shared by the card's summaries. */
export function formatWarrantyDurationLabel(
  duration: number,
  durationUnit: string,
): string {
  const unit = durationUnit.charAt(0).toUpperCase() + durationUnit.slice(1);
  return `${duration} ${unit}`;
}

export const WARRANTY_PROVIDER_LABELS: Record<WarrantyProvider, string> = {
  manufacturer: "Manufacturer",
  seller: "Seller",
  distributor: "Distributor",
  supplier: "Supplier",
  third_party: "Third party",
};

export const WARRANTY_TYPE_LABELS: Record<WarrantyType, string> = {
  repair: "Repair",
  replacement: "Replacement",
  service: "Service",
  limited: "Limited",
  parts_only: "Parts only",
  comprehensive: "Comprehensive",
};

export const WARRANTY_DURATION_UNIT_LABELS: Record<
  WarrantyDurationUnit,
  string
> = {
  days: "Days",
  months: "Months",
  years: "Years",
};
