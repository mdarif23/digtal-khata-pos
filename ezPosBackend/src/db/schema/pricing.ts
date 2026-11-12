import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { categories } from "./categories.js";
import { products } from "./products.js";
import { productVariants } from "./productVariants.js";
import { users } from "./users.js";

/**
 * Percentage-Based Pricing Management (migration 0063; approved design in
 * docs/percentage-pricing/phase-0-audit-and-architecture.md §13).
 *
 * GOVERNING PRINCIPLE: pricing RULES are configuration only — they say how to
 * CALCULATE a recommended price. `product_variants.selling_price` stays the
 * single effective price the POS and storefront charge. Rules materialize into
 * it only through explicit apply / approved proposal / bulk / opt-in
 * auto-update, and every such write appends a `product_price_history` row.
 * Previews never persist.
 */

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/**
 * Per-line price adjustment snapshot stored on sale_items.price_adjustments
 * (migration 0063), in application order. The sales header `discount` keeps
 * its existing conflated meaning; these rows carry the attribution reports
 * need without rewriting any existing semantics.
 */
export interface SalePriceAdjustment {
  kind: "group" | "promotion" | "manual" | "coupon";
  refId: number | null;
  name: string | null;
  amount: number;
  /** Phase 6: mandatory on below-minimum approvals; optional on overrides. */
  reason?: string | null;
}

// ---------------------------------------------------------------------------
// pricing_settings — singleton per business (posSettings pattern). Absent row
// = all defaults: fixed pricing, no rounding, no floor, auto-update off.
// ---------------------------------------------------------------------------

export const pricingSettings = pgTable(
  "pricing_settings",
  {
    businessId: integer("business_id")
      .primaryKey()
      .references(() => businesses.id, { onDelete: "cascade" }),
    defaultMethod: varchar("default_method", { length: 20 })
      .default("fixed")
      .notNull(),
    defaultPercentage: numeric("default_percentage", {
      precision: 6,
      scale: 3,
      mode: "number",
    }),
    roundingIncrement: varchar("rounding_increment", { length: 10 })
      .default("none")
      .notNull(),
    roundingDirection: varchar("rounding_direction", { length: 10 })
      .default("nearest")
      .notNull(),
    autoUpdateEnabled: boolean("auto_update_enabled").default(false).notNull(),
    autoUpdateFixedPrices: boolean("auto_update_fixed_prices")
      .default(false)
      .notNull(),
    minMarginPercent: numeric("min_margin_percent", {
      precision: 5,
      scale: 2,
      mode: "number",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "pricing_settings_method_check",
      sql`(${t.defaultMethod} = 'fixed' AND ${t.defaultPercentage} IS NULL)
        OR (${t.defaultMethod} = 'markup' AND ${t.defaultPercentage} IS NOT NULL AND ${t.defaultPercentage} >= 0)
        OR (${t.defaultMethod} = 'margin' AND ${t.defaultPercentage} IS NOT NULL AND ${t.defaultPercentage} >= 0 AND ${t.defaultPercentage} < 100)`,
    ),
    check(
      "pricing_settings_method_valid_check",
      sql`${t.defaultMethod} IN ('fixed', 'markup', 'margin')`,
    ),
    check(
      "pricing_settings_rounding_increment_check",
      sql`${t.roundingIncrement} IN ('none', '0.01', '1', '5', '10')`,
    ),
    check(
      "pricing_settings_rounding_direction_check",
      sql`${t.roundingDirection} IN ('nearest', 'up', 'down')`,
    ),
    check(
      "pricing_settings_min_margin_check",
      sql`${t.minMarginPercent} IS NULL OR (${t.minMarginPercent} >= 0 AND ${t.minMarginPercent} <= 100)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// pricing_rules — scope hierarchy; exactly one scope per row (all NULL =
// business-wide global). Resolution: variant > product > nearest category
// ancestor > global, first ACTIVE hit wins. At most ONE active rule per
// scope level is enforced by partial unique indexes (migration 0063), so
// ambiguous overlapping rules are impossible rather than adjudicated.
// ---------------------------------------------------------------------------

export const pricingRules = pgTable(
  "pricing_rules",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    categoryId: integer("category_id"),
    productId: integer("product_id"),
    variantId: integer("variant_id"),
    method: varchar("method", { length: 20 }).notNull(),
    percentage: numeric("percentage", {
      precision: 6,
      scale: 3,
      mode: "number",
    }),
    fixedPrice: numeric("fixed_price", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "pricing_rules_scope_check",
      sql`(${t.categoryId} IS NOT NULL AND ${t.productId} IS NULL AND ${t.variantId} IS NULL)
        OR (${t.categoryId} IS NULL AND ${t.productId} IS NOT NULL AND ${t.variantId} IS NULL)
        OR (${t.categoryId} IS NULL AND ${t.productId} IS NULL AND ${t.variantId} IS NOT NULL)
        OR (${t.categoryId} IS NULL AND ${t.productId} IS NULL AND ${t.variantId} IS NULL)`,
    ),
    // Markup and margin are DIFFERENT (master prompt §5.2): margin >= 100 is a
    // division by zero and is rejected at the database level, not just the API.
    check(
      "pricing_rules_method_check",
      sql`(${t.method} = 'fixed' AND ${t.fixedPrice} IS NOT NULL AND ${t.percentage} IS NULL AND ${t.fixedPrice} >= 0)
        OR (${t.method} = 'markup' AND ${t.fixedPrice} IS NULL AND ${t.percentage} IS NOT NULL AND ${t.percentage} >= 0)
        OR (${t.method} = 'margin' AND ${t.fixedPrice} IS NULL AND ${t.percentage} IS NOT NULL AND ${t.percentage} >= 0 AND ${t.percentage} < 100)`,
    ),
    check(
      "pricing_rules_method_valid_check",
      sql`${t.method} IN ('fixed', 'markup', 'margin')`,
    ),
    uniqueIndex("pricing_rules_id_business_uq").on(t.id, t.businessId),
    index("pricing_rules_business_idx").on(t.businessId),
    uniqueIndex("uq_pricing_rule_global")
      .on(t.businessId)
      .where(
        sql`${t.isActive} AND ${t.categoryId} IS NULL AND ${t.productId} IS NULL AND ${t.variantId} IS NULL`,
      ),
    uniqueIndex("uq_pricing_rule_category")
      .on(t.businessId, t.categoryId)
      .where(sql`${t.isActive} AND ${t.productId} IS NULL AND ${t.variantId} IS NULL`),
    uniqueIndex("uq_pricing_rule_product")
      .on(t.businessId, t.productId)
      .where(sql`${t.isActive} AND ${t.variantId} IS NULL`),
    uniqueIndex("uq_pricing_rule_variant")
      .on(t.businessId, t.variantId)
      .where(sql`${t.isActive}`),
    foreignKey({
      columns: [t.categoryId, t.businessId],
      foreignColumns: [categories.id, categories.businessId],
      name: "pricing_rules_category_business_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.productId, t.businessId],
      foreignColumns: [products.id, products.businessId],
      name: "pricing_rules_product_business_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.variantId, t.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "pricing_rules_variant_business_fkey",
    }).onDelete("cascade"),
  ],
);

// ---------------------------------------------------------------------------
// customer_groups — created lazily; NO data backfill (migration 0063).
// ---------------------------------------------------------------------------

export const customerGroups = pgTable(
  "customer_groups",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    description: text(),
    isDefault: boolean("is_default").default(false).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("customer_groups_business_name_unique").on(t.businessId, t.name),
    uniqueIndex("customer_groups_id_business_uq").on(t.id, t.businessId),
    uniqueIndex("uq_customer_groups_default")
      .on(t.businessId)
      .where(sql`${t.isDefault}`),
    index("customer_groups_business_idx").on(t.businessId),
  ],
);

// ---------------------------------------------------------------------------
// customer_group_pricing — whole-cart (all scope ids NULL) or product/
// category/variant scoped group discounts, applied to eligible selling
// prices only (never purchase costs).
// ---------------------------------------------------------------------------

export const customerGroupPricing = pgTable(
  "customer_group_pricing",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    groupId: integer("group_id").notNull(),
    categoryId: integer("category_id"),
    productId: integer("product_id"),
    variantId: integer("variant_id"),
    discountType: varchar("discount_type", { length: 20 }).notNull(),
    discountValue: numeric("discount_value", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    minPurchaseAmount: numeric("min_purchase_amount", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    minQuantity: integer("min_quantity"),
    maxDiscountAmount: numeric("max_discount_amount", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
    validFrom: date("valid_from", { mode: "string" }),
    validTo: date("valid_to", { mode: "string" }),
    stacksWithPromotions: boolean("stacks_with_promotions")
      .default(false)
      .notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "cgp_scope_check",
      sql`(${t.categoryId} IS NOT NULL AND ${t.productId} IS NULL AND ${t.variantId} IS NULL)
        OR (${t.categoryId} IS NULL AND ${t.productId} IS NOT NULL AND ${t.variantId} IS NULL)
        OR (${t.categoryId} IS NULL AND ${t.productId} IS NULL AND ${t.variantId} IS NOT NULL)
        OR (${t.categoryId} IS NULL AND ${t.productId} IS NULL AND ${t.variantId} IS NULL)`,
    ),
    check("cgp_type_check", sql`${t.discountType} IN ('percentage', 'fixed')`),
    check("cgp_value_check", sql`${t.discountValue} >= 0`),
    check(
      "cgp_percentage_cap_check",
      sql`${t.discountType} <> 'percentage' OR ${t.discountValue} <= 100`,
    ),
    check(
      "cgp_dates_check",
      sql`${t.validFrom} IS NULL OR ${t.validTo} IS NULL OR ${t.validFrom} <= ${t.validTo}`,
    ),
    uniqueIndex("cgp_id_business_uq").on(t.id, t.businessId),
    index("cgp_business_group_idx").on(t.businessId, t.groupId),
    foreignKey({
      columns: [t.groupId, t.businessId],
      foreignColumns: [customerGroups.id, customerGroups.businessId],
      name: "cgp_group_business_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.categoryId, t.businessId],
      foreignColumns: [categories.id, categories.businessId],
      name: "cgp_category_business_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.productId, t.businessId],
      foreignColumns: [products.id, products.businessId],
      name: "cgp_product_business_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.variantId, t.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "cgp_variant_business_fkey",
    }).onDelete("cascade"),
  ],
);

// ---------------------------------------------------------------------------
// pricing_promotions — AUTO-APPLIED promotions. Coupons remain untouched
// (code-based, usage-limited); promotions add product/category/variant
// scoping, quantity/order minimums, group eligibility and explicit stacking
// configuration. Evaluation is server-side only, shared by quote and
// createSale (the coupons engine pattern).
// ---------------------------------------------------------------------------

export const pricingPromotions = pgTable(
  "pricing_promotions",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    categoryId: integer("category_id"),
    productId: integer("product_id"),
    variantId: integer("variant_id"),
    discountType: varchar("discount_type", { length: 20 }).notNull(),
    discountValue: numeric("discount_value", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    minQuantity: integer("min_quantity"),
    minOrderValue: numeric("min_order_value", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    maxDiscountAmount: numeric("max_discount_amount", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
    canStackWithGroupDiscount: boolean("can_stack_with_group_discount")
      .default(false)
      .notNull(),
    canStackWithCoupons: boolean("can_stack_with_coupons")
      .default(false)
      .notNull(),
    // ---- Phase 3 extensions (master prompt Feature 8) ----
    /** discount (legacy default) | bogo | buy_x_get_y | mix_match | quantity_tier */
    promoKind: varchar("promo_kind", { length: 20 }).notNull().default("discount"),
    /** Kind-specific configuration, validated by the engine. */
    rule: jsonb("rule").$type<Record<string, unknown>>(),
    /** Day-of-week window (0=Sun .. 6=Sat), evaluated in Asia/Dhaka (UTC+6). */
    daysOfWeek: jsonb("days_of_week").$type<number[]>(),
    /** Time-of-day window "HH:MM" in Asia/Dhaka. */
    startTime: varchar("start_time", { length: 5 }),
    endTime: varchar("end_time", { length: 5 }),
    /** NULL = every location of the business. */
    locationId: integer("location_id"),
    usageLimit: integer("usage_limit"),
    perCustomerLimit: integer("per_customer_limit"),
    /** Higher priority applies first when several promotions match. */
    priority: integer("priority").notNull().default(0),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "promo_scope_check",
      sql`(${t.categoryId} IS NOT NULL AND ${t.productId} IS NULL AND ${t.variantId} IS NULL)
        OR (${t.categoryId} IS NULL AND ${t.productId} IS NOT NULL AND ${t.variantId} IS NULL)
        OR (${t.categoryId} IS NULL AND ${t.productId} IS NULL AND ${t.variantId} IS NOT NULL)
        OR (${t.categoryId} IS NULL AND ${t.productId} IS NULL AND ${t.variantId} IS NULL)`,
    ),
    check("promo_type_check", sql`${t.discountType} IN ('percentage', 'fixed')`),
    check("promo_value_check", sql`${t.discountValue} >= 0`),
    check(
      "promo_percentage_cap_check",
      sql`${t.discountType} <> 'percentage' OR ${t.discountValue} <= 100`,
    ),
    check(
      "promo_dates_check",
      sql`${t.startsAt} IS NULL OR ${t.endsAt} IS NULL OR ${t.startsAt} <= ${t.endsAt}`,
    ),
    uniqueIndex("pricing_promotions_id_business_uq").on(t.id, t.businessId),
    index("pricing_promotions_business_idx").on(t.businessId),
    foreignKey({
      columns: [t.categoryId, t.businessId],
      foreignColumns: [categories.id, categories.businessId],
      name: "promo_category_business_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.productId, t.businessId],
      foreignColumns: [products.id, products.businessId],
      name: "promo_product_business_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.variantId, t.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "promo_variant_business_fkey",
    }).onDelete("cascade"),
  ],
);

/**
 * Group eligibility: NO rows = eligible for every customer; rows = listed
 * groups only (whole-cart and scoped promotions both).
 */
export const promotionCustomerGroups = pgTable(
  "promotion_customer_groups",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    promotionId: integer("promotion_id").notNull(),
    groupId: integer("group_id").notNull(),
  },
  (t) => [
    unique("promo_group_unique").on(t.promotionId, t.groupId),
    index("promo_group_promotion_idx").on(t.promotionId),
    foreignKey({
      columns: [t.promotionId, t.businessId],
      foreignColumns: [pricingPromotions.id, pricingPromotions.businessId],
      name: "promo_group_promotion_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.groupId, t.businessId],
      foreignColumns: [customerGroups.id, customerGroups.businessId],
      name: "promo_group_group_fkey",
    }).onDelete("cascade"),
  ],
);

// ---------------------------------------------------------------------------
// price_change_proposals — Mode A (manual approval, the DEFAULT update mode).
// One sweep run groups its proposals under batchToken; 'stale' marks
// proposals whose cost/price moved after generation.
// ---------------------------------------------------------------------------

export const priceChangeProposals = pgTable(
  "price_change_proposals",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    variantId: integer("variant_id").notNull(),
    batchToken: varchar("batch_token", { length: 64 }).notNull(),
    oldCost: numeric("old_cost", { precision: 14, scale: 6, mode: "number" }),
    newCost: numeric("new_cost", { precision: 14, scale: 6, mode: "number" }),
    oldPrice: numeric("old_price", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
    recommendedPrice: numeric("recommended_price", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    percentChange: numeric("percent_change", {
      precision: 6,
      scale: 2,
      mode: "number",
    }),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    ruleId: integer("rule_id"),
    decidedBy: integer("decided_by").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "pcp_status_check",
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'applied', 'stale')`,
    ),
    index("pcp_business_status_idx").on(t.businessId, t.status),
    index("pcp_business_batch_idx").on(t.businessId, t.batchToken),
    foreignKey({
      columns: [t.variantId, t.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "pcp_variant_business_fkey",
    }).onDelete("cascade"),
    // Plain FK with SET NULL: proposals/history must survive rule deletion
    // with their audit content intact (a composite FK would also NULL
    // business_id).
    foreignKey({
      columns: [t.ruleId],
      foreignColumns: [pricingRules.id],
      name: "pcp_rule_fkey",
    }).onDelete("set null"),
  ],
);

// ---------------------------------------------------------------------------
// product_price_history — every materialized change to
// product_variants.selling_price. NEVER updated or deleted; audit trail for
// reports and rollback analysis.
// ---------------------------------------------------------------------------

export const productPriceHistory = pgTable(
  "product_price_history",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    variantId: integer("variant_id").notNull(),
    oldPrice: numeric("old_price", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
    newPrice: numeric("new_price", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    source: varchar("source", { length: 20 }).notNull(),
    ruleId: integer("rule_id"),
    proposalId: integer("proposal_id"),
    costAtChange: numeric("cost_at_change", {
      precision: 14,
      scale: 6,
      mode: "number",
    }),
    reason: text(),
    changedByUserId: integer("changed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "pph_source_check",
      sql`${t.source} IN ('manual', 'rule_apply', 'proposal', 'auto_update', 'bulk', 'import', 'override')`,
    ),
    index("pph_business_variant_date_idx").on(
      t.businessId,
      t.variantId,
      t.createdAt,
    ),
    foreignKey({
      columns: [t.variantId, t.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "pph_variant_business_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.ruleId],
      foreignColumns: [pricingRules.id],
      name: "pph_rule_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [t.proposalId],
      foreignColumns: [priceChangeProposals.id],
      name: "pph_proposal_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [t.changedByUserId],
      foreignColumns: [users.id],
      name: "pph_user_fkey",
    }).onDelete("set null"),
  ],
);

/**
 * Per-sale promotion usage (Phase 3): idempotent per (business, sale,
 * promotion) so replays never double-count; powers usage_limit and
 * per_customer_limit enforcement.
 */
export const promotionUsage = pgTable(
  "promotion_usage",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    promotionId: integer("promotion_id").notNull(),
    saleId: integer("sale_id").notNull(),
    customerId: integer("customer_id"),
    usedAt: timestamp("used_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("promotion_usage_sale_promo_uq").on(t.businessId, t.saleId, t.promotionId),
    index("promotion_usage_promo_idx").on(t.businessId, t.promotionId),
    index("promotion_usage_customer_idx").on(t.businessId, t.customerId),
  ],
);
