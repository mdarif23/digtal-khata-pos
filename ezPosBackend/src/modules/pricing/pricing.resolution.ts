import { and, eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { categories } from "../../db/schema/categories.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { pricingRules, pricingSettings } from "../../db/schema/pricing.js";
import { NotFoundError } from "../../utils/handleError.js";
import type { PricingConfiguration } from "./pricing.engine.js";

/**
 * Pricing rule RESOLUTION (Phase 2) — shared by the preview service and the
 * rules service. Read-only: it computes WHICH configuration applies to a
 * variant; it never writes prices (separation principle, report §0).
 *
 * PRECEDENCE (approved §13.2): variant > product > nearest category ancestor
 * > global; first ACTIVE rule wins; a missing/inactive rule falls through to
 * the next level, ending at the business default in pricing_settings. The
 * partial unique indexes from migration 0063 make ambiguous overlapping rules
 * impossible — at most one active rule per scope level per business.
 */

type RuleRow = typeof pricingRules.$inferSelect;
type SettingsRow = typeof pricingSettings.$inferSelect;

export type ResolvedPricingSource =
  | { kind: "variant_rule"; ruleId: number; label: string }
  | { kind: "product_rule"; ruleId: number; label: string }
  | {
      kind: "category_rule";
      ruleId: number;
      categoryId: number;
      label: string;
    }
  | { kind: "global_rule"; ruleId: number; label: string }
  | { kind: "settings_default"; ruleId: null; label: string };

export interface ResolvedPricing {
  config: PricingConfiguration;
  source: ResolvedPricingSource;
}

/** The chain walk never goes deeper than this (guard against bad data). */
const MAX_CATEGORY_DEPTH = 25;

export const GLOBAL_RULE_LABEL = "Global rule";
export const SETTINGS_DEFAULT_LABEL = "Business default";

export interface PricingResolutionContext {
  /** All ACTIVE rules of the business (the table is small; one query). */
  activeRules: RuleRow[];
  /** categoryId → parentId for ancestor walking. */
  categoryParents: Map<number, number | null>;
  settings: SettingsRow | null;
}

export async function loadResolutionContext(
  dbe: Pick<typeof db, "select">,
  businessId: number,
): Promise<PricingResolutionContext> {
  const [rules, categoryRows, settingsRows] = await Promise.all([
    dbe
      .select()
      .from(pricingRules)
      .where(
        and(
          eq(pricingRules.businessId, businessId),
          eq(pricingRules.isActive, true),
        ),
      ),
    dbe
      .select({ id: categories.id, parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.businessId, businessId)),
    dbe
      .select()
      .from(pricingSettings)
      .where(eq(pricingSettings.businessId, businessId))
      .limit(1),
  ]);
  const categoryParents = new Map<number, number | null>();
  for (const row of categoryRows) {
    categoryParents.set(row.id, row.parentId ?? null);
  }
  return {
    activeRules: rules,
    categoryParents,
    settings: settingsRows[0] ?? null,
  };
}

export function ruleToConfiguration(rule: RuleRow): PricingConfiguration {
  return {
    method: rule.method as PricingConfiguration["method"],
    percentage: rule.percentage == null ? null : Number(rule.percentage),
    fixedPrice: rule.fixedPrice == null ? null : Number(rule.fixedPrice),
  };
}

export function settingsRowToConfiguration(
  settings: SettingsRow | null,
): PricingConfiguration {
  if (!settings) {
    return { method: "fixed", percentage: null, fixedPrice: null };
  }
  return {
    method: settings.defaultMethod as PricingConfiguration["method"],
    percentage:
      settings.defaultPercentage == null
        ? null
        : Number(settings.defaultPercentage),
    fixedPrice: null,
  };
}

/** Category chain for one product, nearest first. */
export function categoryChainFrom(
  context: PricingResolutionContext,
  startCategoryId: number | null,
): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  let cursor = startCategoryId;
  while (
    cursor != null &&
    !seen.has(cursor) &&
    chain.length < MAX_CATEGORY_DEPTH
  ) {
    seen.add(cursor);
    chain.push(cursor);
    cursor = context.categoryParents.get(cursor) ?? null;
  }
  return chain;
}

export function resolveFromContext(
  context: PricingResolutionContext,
  variant: { id: number; productId: number; categoryId: number | null },
): ResolvedPricing {
  // 1. Variant rule
  const variantRule = context.activeRules.find((r) => r.variantId === variant.id);
  if (variantRule) {
    return {
      config: ruleToConfiguration(variantRule),
      source: { kind: "variant_rule", ruleId: variantRule.id, label: "Variant rule" },
    };
  }
  // 2. Product rule
  const productRule = context.activeRules.find(
    (r) => r.productId === variant.productId,
  );
  if (productRule) {
    return {
      config: ruleToConfiguration(productRule),
      source: { kind: "product_rule", ruleId: productRule.id, label: "Product rule" },
    };
  }
  // 3. Nearest category ancestor (chain is nearest-first).
  for (const categoryId of categoryChainFrom(context, variant.categoryId)) {
    const categoryRule = context.activeRules.find(
      (r) => r.categoryId === categoryId,
    );
    if (categoryRule) {
      return {
        config: ruleToConfiguration(categoryRule),
        source: {
          kind: "category_rule",
          ruleId: categoryRule.id,
          categoryId,
          label: "Category rule",
        },
      };
    }
  }
  // 4. Global rule
  const globalRule = context.activeRules.find(
    (r) => r.categoryId == null && r.productId == null && r.variantId == null,
  );
  if (globalRule) {
    return {
      config: ruleToConfiguration(globalRule),
      source: {
        kind: "global_rule",
        ruleId: globalRule.id,
        label: GLOBAL_RULE_LABEL,
      },
    };
  }
  // 5. Business default
  return {
    config: settingsRowToConfiguration(context.settings),
    source: {
      kind: "settings_default",
      ruleId: null,
      label: SETTINGS_DEFAULT_LABEL,
    },
  };
}

/**
 * Convenience single-variant resolution (materialization paths). Batch
 * callers (preview) should loadResolutionContext once and resolveFromContext
 * per variant.
 */
export async function resolveVariantPricing(
  dbe: Pick<typeof db, "select">,
  businessId: number,
  variantId: number,
  variant?: { id: number; productId: number; categoryId: number | null },
): Promise<ResolvedPricing> {
  let target = variant;
  if (!target) {
    const [row] = await dbe
      .select({
        id: productVariants.id,
        productId: productVariants.productId,
        categoryId: products.categoryId,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(
        and(
          eq(productVariants.id, variantId),
          eq(productVariants.businessId, businessId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError(`Variant ${variantId} not found.`);
    target = row;
  }
  const context = await loadResolutionContext(dbe, businessId);
  return resolveFromContext(context, target);
}
