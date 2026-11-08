import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { categories } from "../../db/schema/categories.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { pricingRules, productPriceHistory } from "../../db/schema/pricing.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { recordAudit, recordAuditInTx } from "../../services/audit.js";
import {
  computeRecommendedPrice,
  evaluateMinimumPrice,
  finalizeRecommendedPrice,
} from "./pricing.engine.js";
import { resolveVariantCost } from "./pricing.costProvider.js";
import { getPricingSettingsView } from "./pricing.service.js";
import {
  pricingRuleStrictSchema,
} from "./pricing.validation.js";
import {
  resolveFromContext,
  loadResolutionContext,
  resolveVariantPricing,
  type ResolvedPricingSource,
} from "./pricing.resolution.js";

/**
 * Pricing rules (Phase 2): CRUD, materialization to the effective selling
 * price, and price history (report §13.2/§18 P2). Resolution lives in
 * pricing.resolution.ts.
 *
 * SEPARATION PRINCIPLE (report §0): rules are configuration. The effective
 * price the POS charges stays product_variants.selling_price. Only
 * applyRecommendedPrice() writes to it — transactionally, with a locked
 * variant row and an immutable product_price_history row. Every other
 * function here is read-only.
 */

type RuleRowFields = {
  categoryId: number | null;
  productId: number | null;
  variantId: number | null;
  method: "fixed" | "markup" | "margin";
  percentage: number | null;
  fixedPrice: number | null;
  isActive: boolean;
};
type PricingRuleUpdateFields = RuleRowFields;

// ---------------------------------------------------------------------------
// Rules CRUD
// ---------------------------------------------------------------------------

function scopeLabel(rule: {
  categoryId: number | null;
  productId: number | null;
  variantId: number | null;
}): string {
  if (rule.variantId != null) return "Variant";
  if (rule.productId != null) return "Product";
  if (rule.categoryId != null) return "Category";
  return "Global";
}

function isRuleScopeConflictError(err: unknown): boolean {
  // Drizzle wraps driver errors in DrizzleQueryError — the pg fields live on
  // the wrapper OR its cause depending on the code path.
  const levels: unknown[] = [err, (err as { cause?: unknown } | null)?.cause];
  for (const level of levels) {
    const e = level as { code?: string; constraint?: string } | null;
    if (
      e &&
      e.code === "23505" &&
      String(e.constraint ?? "").startsWith("uq_pricing_rule")
    ) {
      return true;
    }
  }
  return false;
}

async function assertScopeOwnership(
  businessId: number,
  scope: {
    categoryId?: number | null | undefined;
    productId?: number | null | undefined;
    variantId?: number | null | undefined;
  },
): Promise<void> {
  if (scope.categoryId != null) {
    const [row] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.id, scope.categoryId),
          eq(categories.businessId, businessId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError("Category does not exist.");
  }
  if (scope.productId != null) {
    const [row] = await db
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.id, scope.productId),
          eq(products.businessId, businessId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError("Product does not exist.");
  }
  if (scope.variantId != null) {
    const [row] = await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.id, scope.variantId),
          eq(productVariants.businessId, businessId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError("Variant does not exist.");
  }
}

export async function listRules(businessId: number) {
  const rows = await db
    .select({
      rule: pricingRules,
      categoryName: categories.name,
      productName: products.name,
      sku: productVariants.sku,
      optionLabel: sql<
        string | null
      >`(SELECT string_agg(vo.value, ', ' ORDER BY vv.option_id)
         FROM variant_values vv
         INNER JOIN variant_options vo ON vo.id = vv.option_id
         WHERE vv.variant_id = ${productVariants.id})`,
    })
    .from(pricingRules)
    .leftJoin(
      categories,
      and(
        eq(categories.id, pricingRules.categoryId),
        eq(categories.businessId, pricingRules.businessId),
      ),
    )
    .leftJoin(
      products,
      and(
        eq(products.id, pricingRules.productId),
        eq(products.businessId, pricingRules.businessId),
      ),
    )
    .leftJoin(
      productVariants,
      and(
        eq(productVariants.id, pricingRules.variantId),
        eq(productVariants.businessId, pricingRules.businessId),
      ),
    )
    .where(eq(pricingRules.businessId, businessId))
    .orderBy(desc(pricingRules.isActive), asc(pricingRules.id));
  return rows.map(({ rule, categoryName, productName, sku, optionLabel }) => {
    const variantLabelText =
      optionLabel && optionLabel.trim() !== "" ? `${productName} (${optionLabel.trim()})` : null;
    const scopeParts = [
      rule.categoryId != null ? categoryName : null,
      rule.productId != null ? productName : null,
      rule.variantId != null ? (variantLabelText ?? sku) : null,
    ].filter(Boolean);
    return {
      ...rule,
      percentage: rule.percentage == null ? null : Number(rule.percentage),
      fixedPrice: rule.fixedPrice == null ? null : Number(rule.fixedPrice),
      scope: scopeLabel(rule),
      scopeLabel: scopeParts.join(" › ") || "Whole business",
    };
  });
}

export async function createRule(
  businessId: number,
  actorUserId: number | null,
  payload: {
    categoryId: number | null;
    productId: number | null;
    variantId: number | null;
    method: "fixed" | "markup" | "margin";
    percentage: number | null;
    fixedPrice: number | null;
    isActive: boolean;
  },
) {
  await assertScopeOwnership(businessId, payload);
  try {
    const [created] = await db
      .insert(pricingRules)
      .values({
        businessId,
        categoryId: payload.categoryId,
        productId: payload.productId,
        variantId: payload.variantId,
        method: payload.method,
        percentage: payload.percentage,
        fixedPrice: payload.fixedPrice,
        isActive: payload.isActive,
      })
      .returning();
    if (!created) throw new Error("Rule insert returned no row.");
    recordAudit({
      businessId,
      actorUserId,
      action: "pricing.rule.create",
      entityType: "pricing_rule",
      entityId: created.id,
      metadata: {
        scope: scopeLabel(created),
        method: created.method,
        percentage: created.percentage,
        fixedPrice: created.fixedPrice,
      },
    });
    return created;
  } catch (err) {
    if (isRuleScopeConflictError(err)) {
      throw new ConflictError(
        "An active rule already exists for this scope — deactivate or edit it first.",
      );
    }
    throw err;
  }
}

export async function updateRule(
  businessId: number,
  actorUserId: number | null,
  ruleId: number,
  payload: {
    [K in keyof PricingRuleUpdateFields]?: PricingRuleUpdateFields[K] | undefined;
  },
) {
  const [existing] = await db
    .select()
    .from(pricingRules)
    .where(
      and(eq(pricingRules.id, ruleId), eq(pricingRules.businessId, businessId)),
    )
    .limit(1);
  if (!existing) throw new NotFoundError("Pricing rule not found.");
  const merged = {
    categoryId:
      payload.categoryId !== undefined ? payload.categoryId : existing.categoryId,
    productId:
      payload.productId !== undefined ? payload.productId : existing.productId,
    variantId:
      payload.variantId !== undefined ? payload.variantId : existing.variantId,
    method: payload.method ?? existing.method,
    percentage:
      payload.percentage !== undefined
        ? payload.percentage
        : existing.percentage == null
          ? null
          : Number(existing.percentage),
    fixedPrice:
      payload.fixedPrice !== undefined
        ? payload.fixedPrice
        : existing.fixedPrice == null
          ? null
          : Number(existing.fixedPrice),
    isActive: payload.isActive ?? existing.isActive,
  };
  // Validate the MERGED object so a partial update cannot dodge the
  // scope/method invariants (e.g. switching method to 'fixed' while a
  // percentage lingers) before the DB CHECK rejects them as a 500.
  const parsed = pricingRuleStrictSchema.safeParse(merged);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid pricing rule update: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  await assertScopeOwnership(businessId, merged);
  try {
    const [updated] = await db
      .update(pricingRules)
      .set({
        categoryId: merged.categoryId,
        productId: merged.productId,
        variantId: merged.variantId,
        method: merged.method,
        percentage: merged.percentage,
        fixedPrice: merged.fixedPrice,
        isActive: merged.isActive,
        updatedAt: new Date(),
      })
      .where(
        and(eq(pricingRules.id, ruleId), eq(pricingRules.businessId, businessId)),
      )
      .returning();
    if (!updated) throw new Error("Rule update returned no row.");
    recordAudit({
      businessId,
      actorUserId,
      action: "pricing.rule.update",
      entityType: "pricing_rule",
      entityId: ruleId,
      metadata: { scope: scopeLabel(updated), isActive: updated.isActive },
    });
    return updated;
  } catch (err) {
    if (isRuleScopeConflictError(err)) {
      throw new ConflictError(
        "An active rule already exists for this scope — deactivate or edit it first.",
      );
    }
    throw err;
  }
}

export async function deleteRule(businessId: number, ruleId: number) {
  // History/proposals keep their content via ON DELETE SET NULL FKs.
  const [deleted] = await db
    .delete(pricingRules)
    .where(
      and(eq(pricingRules.id, ruleId), eq(pricingRules.businessId, businessId)),
    )
    .returning();
  if (!deleted) throw new NotFoundError("Pricing rule not found.");
  return deleted;
}

// ---------------------------------------------------------------------------
// Materialization — the ONLY pricing-module writer of the effective price
// ---------------------------------------------------------------------------

export interface ApplyPriceResult {
  applied: boolean;
  oldPrice: number;
  newPrice: number | null;
  ruleId: number | null;
  source: ResolvedPricingSource;
  method: "fixed" | "markup" | "margin";
  /** 6-dp weighted-avg landed cost used for percentage methods. */
  costAtChange: number | null;
  /** Rounded by the business's final-stage rounding configuration. */
  recommendedPrice: number | null;
  unchanged?: boolean;
}

export async function applyRecommendedPrice(
  businessId: number,
  actorUserId: number | null,
  variantId: number,
  reason?: string | null,
): Promise<ApplyPriceResult> {
  return db.transaction(async (tx) => {
    const [variant] = await tx
      .select({
        id: productVariants.id,
        productId: productVariants.productId,
        sellingPrice: productVariants.sellingPrice,
        minSellingPrice: productVariants.minSellingPrice,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.id, variantId),
          eq(productVariants.businessId, businessId),
        ),
      )
      .for("update");
    if (!variant) throw new NotFoundError(`Variant ${variantId} not found.`);
    const [productRow] = await tx
      .select({ categoryId: products.categoryId })
      .from(products)
      .where(eq(products.id, variant.productId))
      .limit(1);
    if (!productRow) {
      throw new NotFoundError(`Product for variant ${variantId} not found.`);
    }

    const resolved = await resolveVariantPricing(tx, businessId, variantId, {
      id: variant.id,
      productId: variant.productId,
      categoryId: productRow.categoryId,
    });

    // The selling price is business-global; the cost basis is the global
    // weighted average (no location narrowing — per-location price variants
    // do not exist in this system, report §2.1).
    const needsCost = resolved.config.method !== "fixed";
    let costMicros: bigint | null = null;
    let cost: number | null = null;
    if (needsCost) {
      const costResolution = await resolveVariantCost(
        tx,
        businessId,
        variantId,
        null,
      );
      if (costResolution.status === "available") {
        costMicros = costResolution.costMicros;
        cost = costResolution.cost;
      }
    }

    const engineResult = computeRecommendedPrice(resolved.config, costMicros);
    const settings = await getPricingSettingsView(businessId);
    const finalized = finalizeRecommendedPrice(
      engineResult,
      settings.roundingIncrement,
      settings.roundingDirection,
    );

    if (finalized.status !== "ok") {
      if (finalized.status === "cost_unavailable") {
        throw new ConflictError(
          `${finalized.reason} Set a fixed price or add priced inventory first.`,
        );
      }
      throw new BadRequestError(finalized.reason);
    }

    const oldPrice = Number(variant.sellingPrice);
    const newPrice = finalized.price;
    if (newPrice === oldPrice) {
      return {
        applied: false,
        unchanged: true,
        oldPrice,
        newPrice: null,
        ruleId: resolved.source.ruleId,
        source: resolved.source,
        method: resolved.config.method,
        costAtChange: cost,
        recommendedPrice: newPrice,
      };
    }

    const check = evaluateMinimumPrice({
      price: newPrice,
      cost: cost == null ? null : Math.round(cost * 100) / 100,
      minSellingPrice:
        variant.minSellingPrice == null
          ? null
          : Number(variant.minSellingPrice),
      minMarginPercent: settings.minMarginPercent,
    });
    if (check.violated) {
      throw new ConflictError(
        `Recommended price ${newPrice.toFixed(2)} violates the configured minimum (${check.violations.join(", ")}). Adjust the floors before applying.`,
      );
    }

    await tx
      .update(productVariants)
      .set({ sellingPrice: newPrice })
      .where(
        and(
          eq(productVariants.id, variantId),
          eq(productVariants.businessId, businessId),
        ),
      );
    // updated_at (LAN sync watermark) is maintained by trigger.

    const [historyRow] = await tx
      .insert(productPriceHistory)
      .values({
        businessId,
        variantId,
        oldPrice,
        newPrice,
        source: "rule_apply",
        ruleId: resolved.source.ruleId,
        costAtChange: cost,
        reason: reason?.trim() || null,
        changedByUserId: actorUserId,
      })
      .returning();
    if (!historyRow) throw new Error("Price history insert returned no row.");

    await recordAuditInTx(tx as never, {
      businessId,
      actorUserId,
      action: "pricing.price.applied",
      entityType: "product_variant",
      entityId: variantId,
      metadata: {
        oldPrice,
        newPrice,
        sourceKind: resolved.source.kind,
        ruleId: resolved.source.ruleId,
        historyId: historyRow.id,
        ...(reason ? { reason } : {}),
      },
    });

    return {
      applied: true,
      oldPrice,
      newPrice,
      ruleId: resolved.source.ruleId,
      source: resolved.source,
      method: resolved.config.method,
      costAtChange: cost,
      recommendedPrice: newPrice,
    };
  });
}

// ---------------------------------------------------------------------------
// Price history + effective pricing view
// ---------------------------------------------------------------------------

export async function listPriceHistory(
  businessId: number,
  input: { variantId?: number | null | undefined; page: number; pageSize: number },
) {
  const filters = [eq(productPriceHistory.businessId, businessId)];
  if (input.variantId != null) {
    filters.push(eq(productPriceHistory.variantId, input.variantId));
  }
  const where = and(...filters);
  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(productPriceHistory)
    .where(where);
  const total = Number(countRows[0]?.count ?? 0);
  const rows = await db
    .select({
      history: productPriceHistory,
      sku: productVariants.sku,
      productName: products.name,
    })
    .from(productPriceHistory)
    .innerJoin(
      productVariants,
      and(
        eq(productVariants.id, productPriceHistory.variantId),
        eq(productVariants.businessId, productPriceHistory.businessId),
      ),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(where)
    .orderBy(desc(productPriceHistory.createdAt), desc(productPriceHistory.id))
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize);
  return {
    rows: rows.map(({ history, sku, productName }) => ({
      ...history,
      oldPrice: history.oldPrice == null ? null : Number(history.oldPrice),
      newPrice: Number(history.newPrice),
      costAtChange:
        history.costAtChange == null ? null : Number(history.costAtChange),
      sku,
      productName,
    })),
    meta: {
      page: input.page,
      pageSize: input.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / input.pageSize)),
    },
  };
}

/** Effective pricing view for GET /api/pricing/products/:variantId/price. */
export async function getVariantPricingView(businessId: number, variantId: number) {
  const [variant] = await db
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      categoryId: products.categoryId,
      sku: productVariants.sku,
      sellingPrice: productVariants.sellingPrice,
      minSellingPrice: productVariants.minSellingPrice,
      productName: products.name,
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
  if (!variant) throw new NotFoundError(`Variant ${variantId} not found.`);

  const context = await loadResolutionContext(db, businessId);
  const resolved = resolveFromContext(context, {
    id: variant.id,
    productId: variant.productId,
    categoryId: variant.categoryId,
  });

  const needsCost = resolved.config.method !== "fixed";
  let costMicros: bigint | null = null;
  let cost: number | null = null;
  if (needsCost) {
    const costResolution = await resolveVariantCost(db, businessId, variantId, null);
    if (costResolution.status === "available") {
      costMicros = costResolution.costMicros;
      cost = costResolution.cost;
    }
  }
  const engineResult = computeRecommendedPrice(resolved.config, costMicros);
  const settings = await getPricingSettingsView(businessId);
  const finalized = finalizeRecommendedPrice(
    engineResult,
    settings.roundingIncrement,
    settings.roundingDirection,
  );

  let minimumViolations: ("minimum_price" | "minimum_margin")[] = [];
  if (finalized.status === "ok") {
    const check = evaluateMinimumPrice({
      price: finalized.price,
      cost: cost == null ? null : Math.round(cost * 100) / 100,
      minSellingPrice:
        variant.minSellingPrice == null
          ? null
          : Number(variant.minSellingPrice),
      minMarginPercent: settings.minMarginPercent,
    });
    minimumViolations = check.violations;
  }

  return {
    variantId,
    productId: variant.productId,
    sku: variant.sku,
    productName: variant.productName,
    currentSellingPrice: Number(variant.sellingPrice),
    minSellingPrice:
      variant.minSellingPrice == null ? null : Number(variant.minSellingPrice),
    source: resolved.source,
    method: resolved.config.method,
    percentage: resolved.config.percentage,
    fixedPrice: resolved.config.fixedPrice,
    costStatus: needsCost
      ? costMicros != null
        ? ("available" as const)
        : ("unavailable" as const)
      : ("not_required" as const),
    cost,
    recommendedPrice: finalized.status === "ok" ? finalized.price : null,
    unavailableReason: finalized.status === "ok" ? null : finalized.reason,
    minimumViolations,
    rounding: {
      increment: settings.roundingIncrement,
      direction: settings.roundingDirection,
    },
  };
}
