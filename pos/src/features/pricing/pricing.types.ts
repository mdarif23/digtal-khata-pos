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

// ---------------------------------------------------------------------------
// Phase 5-8: promotions, customer groups, bulk, proposals, reports
// ---------------------------------------------------------------------------

export interface Promotion {
  id: number;
  name: string;
  categoryId: number | null;
  productId: number | null;
  variantId: number | null;
  discountType: "percentage" | "fixed";
  discountValue: number;
  startsAt: string | null;
  endsAt: string | null;
  minQuantity: number | null;
  minOrderValue: number;
  maxDiscountAmount: number | null;
  canStackWithGroupDiscount: boolean;
  canStackWithCoupons: boolean;
  isActive: boolean;
  // Phase 3 (Feature 8) engine config — the edit form must round-trip
  // these exactly; the backend merges defined PATCH values over the row.
  promoKind: "discount" | "bogo" | "buy_x_get_y" | "mix_match" | "quantity_tier";
  /** Kind-specific rule payload: {buyQty,getQty} | {comboSize,discountPercent} | {tiers:[…]}. */
  rule: Record<string, unknown> | null;
  daysOfWeek: number[] | null;
  startTime: string | null;
  endTime: string | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  priority: number;
  scopeLabel: string;
  customerGroups: { id: number; name: string }[];
}

export interface PromotionInput {
  name: string;
  categoryId?: number | null;
  productId?: number | null;
  variantId?: number | null;
  discountType: "percentage" | "fixed";
  discountValue: number;
  startsAt?: string | null;
  endsAt?: string | null;
  minQuantity?: number | null;
  minOrderValue?: number;
  maxDiscountAmount?: number | null;
  canStackWithGroupDiscount?: boolean;
  canStackWithCoupons?: boolean;
  isActive?: boolean;
  groupIds?: number[];
}

export interface CustomerGroup {
  id: number;
  name: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  memberCount: number;
  pricingCount: number;
}

export interface GroupPricingRow {
  id: number;
  groupId: number;
  categoryId: number | null;
  productId: number | null;
  variantId: number | null;
  discountType: "percentage" | "fixed";
  discountValue: number;
  minPurchaseAmount: number;
  minQuantity: number | null;
  maxDiscountAmount: number | null;
  validFrom: string | null;
  validTo: string | null;
  stacksWithPromotions: boolean;
  isActive: boolean;
  scopeLabel: string;
}

export interface BulkRow {
  variantId: number;
  variantName: string;
  sku: string | null;
  currentPrice: number;
  recommended: number | null;
  changed: boolean;
  cost: number | null;
  method: string;
  sourceLabel: string;
  applied: boolean;
  blockedReason: string | null;
}

export interface BulkResult {
  rows: BulkRow[];
  appliedCount: number;
}

export interface PriceProposal {
  id: number;
  variantId: number;
  batchToken: string;
  oldCost: number | null;
  newCost: number | null;
  oldPrice: number | null;
  recommendedPrice: number;
  percentChange: number | null;
  status: "pending" | "approved" | "rejected" | "applied" | "stale";
  decidedAt: string | null;
  createdAt: string;
  sku: string;
  productName: string;
}

export interface GroupProfitabilityRow {
  groupId: number | null;
  groupName: string;
  salesCount: number;
  grossSales: number;
  itemDiscounts: number;
  groupDiscounts: number;
  promotionDiscounts: number;
  netRevenue: number;
  totalCost: number;
  netProfit: number;
  marginPercent: number;
}

export interface PromotionPerformanceRow {
  promotionId: number;
  promotionName: string;
  salesCount: number;
  totalDiscount: number;
}
