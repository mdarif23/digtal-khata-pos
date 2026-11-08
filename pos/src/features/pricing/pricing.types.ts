/**
 * Pricing feature types — mirrors ezPosBackend/src/modules/pricing response
 * shapes (docs/percentage-pricing/phase-0-audit-and-architecture.md §14).
 */

export type PricingMethod = "fixed" | "markup" | "margin";
export type RoundingIncrement = "none" | "0.01" | "1" | "5" | "10";
export type RoundingDirection = "nearest" | "up" | "down";

export interface PricingSettings {
  defaultMethod: PricingMethod;
  defaultPercentage: number | null;
  roundingIncrement: RoundingIncrement;
  roundingDirection: RoundingDirection;
  autoUpdateEnabled: boolean;
  autoUpdateFixedPrices: boolean;
  minMarginPercent: number | null;
  updatedAt: string | null;
}

export interface PricingRule {
  id: number;
  businessId: number;
  categoryId: number | null;
  productId: number | null;
  variantId: number | null;
  method: PricingMethod;
  percentage: number | null;
  fixedPrice: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  scope: "Global" | "Category" | "Product" | "Variant";
  scopeLabel: string;
}

export interface PricingRuleInput {
  categoryId?: number | null;
  productId?: number | null;
  variantId?: number | null;
  method: PricingMethod;
  percentage?: number | null;
  fixedPrice?: number | null;
  isActive?: boolean;
}

/** Where a configuration came from (rule precedence → settings → what-if). */
export type PricingSource =
  | { kind: "variant_rule"; ruleId: number; label: string }
  | { kind: "product_rule"; ruleId: number; label: string }
  | { kind: "category_rule"; ruleId: number; categoryId: number; label: string }
  | { kind: "global_rule"; ruleId: number; label: string }
  | { kind: "settings_default"; ruleId: null; label: string }
  | { kind: "request_override"; ruleId: null; label: string };

export interface PricingPreviewRow {
  variantId: number;
  productId: number;
  productName: string;
  sku: string;
  currentSellingPrice: number;
  minSellingPrice: number | null;
  source: PricingSource;
  method: PricingMethod;
  percentage: number | null;
  fixedPrice: number | null;
  costStatus: "available" | "unavailable" | "not_required";
  cost: number | null;
  recommendedPrice: number | null;
  unavailableReason: string | null;
  minimumViolations: ("minimum_price" | "minimum_margin")[];
}

export interface EffectivePricing {
  variantId: number;
  productId: number;
  sku: string;
  productName: string;
  currentSellingPrice: number;
  minSellingPrice: number | null;
  source: PricingSource;
  method: PricingMethod;
  percentage: number | null;
  fixedPrice: number | null;
  costStatus: "available" | "unavailable" | "not_required";
  cost: number | null;
  recommendedPrice: number | null;
  unavailableReason: string | null;
  minimumViolations: ("minimum_price" | "minimum_margin")[];
  rounding: { increment: RoundingIncrement; direction: RoundingDirection };
}

export interface ApplyPriceResult {
  applied: boolean;
  oldPrice: number;
  newPrice: number | null;
  ruleId: number | null;
  source: PricingSource;
  method: PricingMethod;
  recommendedPrice: number | null;
  unchanged?: boolean;
}

export interface PriceHistoryRow {
  id: number;
  variantId: number;
  oldPrice: number | null;
  newPrice: number;
  source: string;
  ruleId: number | null;
  costAtChange: number | null;
  reason: string | null;
  createdAt: string;
  sku: string;
  productName: string;
}

export interface Paginated<T> {
  rows: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

/** A catalog variant as shown in the pricing matrix (from /api/products). */
export interface MatrixVariant {
  variantId: number;
  productId: number;
  productName: string;
  sku: string;
  sellingPrice: number;
  quantity: number | null;
  purchaseCost: number | null;
}
