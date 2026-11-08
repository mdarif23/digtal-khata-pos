import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import {
  priceChangeProposals,
  productPriceHistory,
} from "../../db/schema/pricing.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { recordAuditInTx } from "../../services/audit.js";
import { roundMoney } from "../../utils/roundMoney.js";
import {
  computeRecommendedPrice,
  evaluateMinimumPrice,
  finalizeRecommendedPrice,
} from "./pricing.engine.js";
import { resolveVariantPricing } from "./pricing.resolution.js";
import { resolveVariantCost } from "./pricing.costProvider.js";
import { getPricingSettingsView } from "./pricing.service.js";
import type { DbTransaction } from "../../config/db.js";

/**
 * Phase 8 — bulk materialization, Mode A proposals, Mode B auto-update.
 * Everything here funnels through the ONE sanctioned write to
 * `product_variants.selling_price`: engine recommendation → final-stage
 * rounding → minimum-floor check → transactional write + product_price_history
 * + audit. Previews never persist; every applied change is traceable.
 */

interface Recommendation {
  variantId: number;
  oldPrice: number;
  recommended: number | null;
  cost: number | null;
  ruleId: number | null;
  method: string;
  sourceLabel: string;
  isFixedSource: boolean;
  blockedReason: string | null;
}

/**
 * Pure recommendation for one variant (no writes). `blockedReason` carries an
 * explicit failure (cost unavailable / margin ≥ 100 / floor violation) — a
 * blocked recommendation is NEVER silently priced from nothing.
 */
async function recommendForVariant(
  tx: DbTransaction,
  businessId: number,
  variantId: number,
): Promise<Recommendation> {
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
    .limit(1);
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

  const needsCost = resolved.config.method !== "fixed";
  let cost: number | null = null;
  let costMicros: bigint | null = null;
  if (needsCost) {
    const costResolution = await resolveVariantCost(tx, businessId, variantId, null);
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

  const base = {
    variantId,
    oldPrice: Number(variant.sellingPrice),
    cost,
    ruleId: resolved.source.ruleId,
    method: resolved.config.method,
    sourceLabel: resolved.source.label,
    isFixedSource: resolved.config.method === "fixed",
  };

  if (finalized.status !== "ok") {
    return {
      ...base,
      recommended: null,
      blockedReason:
        finalized.status === "cost_unavailable"
          ? "Cost unavailable — no priced inventory batches on hand."
          : finalized.reason,
    };
  }

  const check = evaluateMinimumPrice({
    price: finalized.price,
    cost: cost == null ? null : Math.round(cost * 100) / 100,
    minSellingPrice:
      variant.minSellingPrice == null ? null : Number(variant.minSellingPrice),
    minMarginPercent: settings.minMarginPercent,
  });
  if (check.violated) {
    return {
      ...base,
      recommended: finalized.price,
      blockedReason: `Minimum floor violated (${check.violations.join(", ")}).`,
    };
  }

  return { ...base, recommended: finalized.price, blockedReason: null };
}

/**
 * THE transactional materialization (shared by applyRecommendedPrice-style
 * single applies, bulk, proposals and the auto-update sweep). Caller holds
 * the variant FOR UPDATE. Writes the price + history row with the given
 * source and returns the history id.
 */
async function materializePrice(
  tx: DbTransaction,
  params: {
    businessId: number;
    actorUserId: number | null;
    variantId: number;
    oldPrice: number;
    newPrice: number;
    cost: number | null;
    ruleId: number | null;
    source: "rule_apply" | "proposal" | "auto_update" | "bulk" | "import" | "override" | "manual";
    proposalId?: number | null;
    reason?: string | null;
    auditAction: string;
    auditMetadata?: Record<string, unknown>;
  },
): Promise<number> {
  await tx
    .update(productVariants)
    .set({ sellingPrice: params.newPrice })
    .where(
      and(
        eq(productVariants.id, params.variantId),
        eq(productVariants.businessId, params.businessId),
      ),
    );
  // updated_at (LAN sync watermark) is maintained by trigger.

  const [historyRow] = await tx
    .insert(productPriceHistory)
    .values({
      businessId: params.businessId,
      variantId: params.variantId,
      oldPrice: params.oldPrice,
      newPrice: params.newPrice,
      source: params.source,
      ruleId: params.ruleId ?? null,
      proposalId: params.proposalId ?? null,
      costAtChange: params.cost,
      reason: params.reason?.trim() || null,
      changedByUserId: params.actorUserId,
    })
    .returning({ id: productPriceHistory.id });
  if (!historyRow) throw new Error("Price history insert returned no row.");

  await recordAuditInTx(tx as never, {
    businessId: params.businessId,
    actorUserId: params.actorUserId,
    action: params.auditAction,
    entityType: "product_variant",
    entityId: params.variantId,
    metadata: {
      oldPrice: params.oldPrice,
      newPrice: params.newPrice,
      historyId: historyRow.id,
      ...(params.ruleId != null ? { ruleId: params.ruleId } : {}),
      ...(params.proposalId != null ? { proposalId: params.proposalId } : {}),
      ...(params.auditMetadata ?? {}),
    },
  });
  return historyRow.id;
}

// ---------------------------------------------------------------------------
// Bulk update (Phase 8) — filter → dryRun preview | apply.
// ---------------------------------------------------------------------------

export interface BulkFilter {
  variantIds?: number[] | undefined;
  categoryIds?: number[] | undefined;
  productIds?: number[] | undefined;
  search?: string | undefined;
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

async function resolveBulkVariants(
  businessId: number,
  filter: BulkFilter,
): Promise<number[]> {
  const conditions = [eq(productVariants.businessId, businessId)];
  if (filter.variantIds?.length) {
    conditions.push(inArray(productVariants.id, filter.variantIds));
  }
  if (filter.categoryIds?.length || filter.productIds?.length || filter.search) {
    const productConditions = [eq(products.businessId, businessId)];
    if (filter.categoryIds?.length) {
      productConditions.push(inArray(products.categoryId, filter.categoryIds));
    }
    if (filter.productIds?.length) {
      productConditions.push(inArray(products.id, filter.productIds));
    }
    if (filter.search) {
      productConditions.push(sql`${products.name} ILIKE ${"%" + filter.search + "%"}`);
    }
    const productRows = await db
      .select({ id: products.id })
      .from(products)
      .where(and(...productConditions));
    if (productRows.length === 0) return [];
    conditions.push(
      inArray(
        productVariants.productId,
        productRows.map((p) => p.id),
      ),
    );
  }
  const rows = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(and(...conditions))
    .limit(500);
  return rows.map((r) => r.id);
}

export async function bulkUpdatePrices(
  businessId: number,
  actorUserId: number | null,
  filter: BulkFilter,
  mode: "preview" | "apply",
  reason?: string | null,
): Promise<{ rows: BulkRow[]; appliedCount: number }> {
  const variantIds = await resolveBulkVariants(businessId, filter);
  if (variantIds.length === 0) return { rows: [], appliedCount: 0 };

  return db.transaction(async (tx) => {
    const rows: BulkRow[] = [];
    let appliedCount = 0;
    for (const variantId of variantIds) {
      const rec = await recommendForVariant(tx, businessId, variantId);
      const [meta] = await tx
        .select({
          sku: productVariants.sku,
          productName: products.name,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(eq(productVariants.id, variantId))
        .limit(1);
      const changed =
        rec.recommended != null && rec.recommended !== rec.oldPrice;
      const row: BulkRow = {
        variantId,
        variantName: meta?.productName ?? `Variant ${variantId}`,
        sku: meta?.sku ?? null,
        currentPrice: rec.oldPrice,
        recommended: rec.recommended,
        changed,
        cost: rec.cost,
        method: rec.method,
        sourceLabel: rec.sourceLabel,
        applied: false,
        blockedReason: rec.blockedReason,
      };
      if (mode === "apply" && changed && !rec.blockedReason) {
        await materializePrice(tx, {
          businessId,
          actorUserId,
          variantId,
          oldPrice: rec.oldPrice,
          newPrice: rec.recommended!,
          cost: rec.cost,
          ruleId: rec.ruleId,
          source: "bulk",
          reason: reason ?? null,
          auditAction: "pricing.price.bulk_applied",
        });
        row.applied = true;
        appliedCount++;
      }
      rows.push(row);
    }
    if (mode === "apply") {
      await recordAuditInTx(tx as never, {
        businessId,
        actorUserId,
        action: "pricing.bulk_update",
        entityType: "pricing",
        entityId: null,
        metadata: {
          requested: rows.length,
          applied: appliedCount,
          blocked: rows.filter((r) => !r.applied && r.blockedReason).length,
        },
      });
    }
    return { rows, appliedCount };
  });
}

// ---------------------------------------------------------------------------
// Mode A proposals — cost/rule changes become reviewable rows; approval is
// the sanctioned write. batchToken groups one sweep run.
// ---------------------------------------------------------------------------

function newBatchToken(): string {
  return `sweep-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Every variant an ACTIVE rule can reach, mirroring the resolution
 * precedence (variant > product > nearest category ancestor > global):
 * variant-scoped rules contribute themselves, product rules their variants,
 * category rules their subtree's variants, and a global rule the whole
 * catalog (capped). Both the Mode A generator and the Mode B sweep scan
 * exactly this set.
 */
async function ruleCoveredVariantIds(
  tx: DbTransaction,
  businessId: number,
): Promise<number[]> {
  const result = await tx.execute(sql`
    WITH RECURSIVE
    active_rules AS (
      SELECT category_id, product_id, variant_id
      FROM pricing_rules
      WHERE business_id = ${businessId} AND is_active = true
    ),
    cat_tree AS (
      SELECT r.category_id AS id
      FROM active_rules r
      WHERE r.category_id IS NOT NULL
      UNION
      SELECT c.id
      FROM categories c
      INNER JOIN cat_tree t ON c.parent_id = t.id
      WHERE c.business_id = ${businessId}
    ),
    covered AS (
      SELECT r.variant_id AS vid
      FROM active_rules r
      WHERE r.variant_id IS NOT NULL
      UNION
      SELECT pv.id
      FROM product_variants pv
      INNER JOIN active_rules r ON r.product_id = pv.product_id
      UNION
      SELECT pv.id
      FROM product_variants pv
      INNER JOIN products p ON p.id = pv.product_id
      WHERE p.business_id = ${businessId}
        AND p.category_id IN (SELECT id FROM cat_tree)
      UNION
      SELECT pv.id
      FROM product_variants pv
      WHERE pv.business_id = ${businessId}
        AND EXISTS (
          SELECT 1 FROM active_rules r
          WHERE r.category_id IS NULL AND r.product_id IS NULL AND r.variant_id IS NULL
        )
    )
    SELECT DISTINCT vid FROM covered LIMIT 1000
  `);
  return (result.rows as { vid: number }[]).map((r) => Number(r.vid));
}

export async function generateProposals(
  businessId: number,
  actorUserId: number | null,
): Promise<{
  batchToken: string;
  created: number;
  staled: number;
  unchanged: number;
}> {
  return db.transaction(async (tx) => {
    // Advisory lock: two concurrent sweeps would double-stale/create.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`pricing-proposals:${businessId}`}))`);

    const variantIds = await ruleCoveredVariantIds(tx, businessId);

    const batchToken = newBatchToken();
    let created = 0;
    let staled = 0;
    let unchanged = 0;

    for (const variantId of variantIds) {
      const rec = await recommendForVariant(tx, businessId, variantId);
      if (rec.recommended == null || rec.blockedReason) {
        unchanged++;
        continue;
      }
      const pending = await tx
        .select()
        .from(priceChangeProposals)
        .where(
          and(
            eq(priceChangeProposals.businessId, businessId),
            eq(priceChangeProposals.variantId, variantId),
            eq(priceChangeProposals.status, "pending"),
          ),
        );
      const matching = pending.find(
        (p) =>
          Number(p.recommendedPrice) === rec.recommended &&
          (p.newCost == null
            ? rec.cost == null
            : rec.cost != null && Number(p.newCost) === rec.cost),
      );
      if (matching) {
        unchanged++;
        continue;
      }
      // Cost/price moved: stale the old pending rows, create fresh ones.
      if (pending.length > 0) {
        await tx
          .update(priceChangeProposals)
          .set({ status: "stale", updatedAt: new Date() })
          .where(
            and(
              eq(priceChangeProposals.businessId, businessId),
              eq(priceChangeProposals.variantId, variantId),
              eq(priceChangeProposals.status, "pending"),
            ),
          );
        staled += pending.length;
      }
      const percentChange =
        rec.oldPrice > 0
          ? Math.round(((rec.recommended - rec.oldPrice) / rec.oldPrice) * 10000) / 100
          : null;
      await tx.insert(priceChangeProposals).values({
        businessId,
        variantId,
        batchToken,
        oldCost: rec.cost,
        newCost: rec.cost,
        oldPrice: rec.oldPrice,
        recommendedPrice: rec.recommended,
        percentChange,
        status: "pending",
        ruleId: rec.ruleId,
      });
      created++;
    }

    await recordAuditInTx(tx as never, {
      businessId,
      actorUserId,
      action: "pricing.proposals.generated",
      entityType: "pricing",
      entityId: null,
      metadata: { batchToken, created, staled, unchanged, scanned: variantIds.length },
    });
    return { batchToken, created, staled, unchanged };
  });
}

export async function listProposals(
  businessId: number,
  status: string | undefined,
  page: number,
  pageSize: number,
) {
  const conditions = [eq(priceChangeProposals.businessId, businessId)];
  if (status) {
    conditions.push(
      eq(
        priceChangeProposals.status,
        status as typeof priceChangeProposals.$inferSelect["status"],
      ),
    );
  }
  const where = and(...conditions);
  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(priceChangeProposals)
    .where(where);
  const count = countRows[0]?.count ?? 0;
  const rows = await db
    .select({
      proposal: priceChangeProposals,
      sku: productVariants.sku,
      productName: products.name,
    })
    .from(priceChangeProposals)
    .innerJoin(
      productVariants,
      and(
        eq(productVariants.id, priceChangeProposals.variantId),
        eq(productVariants.businessId, priceChangeProposals.businessId),
      ),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(where)
    .orderBy(desc(priceChangeProposals.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    rows: rows.map(({ proposal, sku, productName }) => ({
      ...proposal,
      recommendedPrice: Number(proposal.recommendedPrice),
      oldPrice: proposal.oldPrice == null ? null : Number(proposal.oldPrice),
      oldCost: proposal.oldCost == null ? null : Number(proposal.oldCost),
      newCost: proposal.newCost == null ? null : Number(proposal.newCost),
      percentChange:
        proposal.percentChange == null ? null : Number(proposal.percentChange),
      sku,
      productName,
    })),
    meta: {
      page,
      pageSize,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / pageSize)),
    },
  };
}

export async function decideProposal(
  businessId: number,
  actorUserId: number | null,
  proposalId: number,
  decision: "approve" | "reject",
  reason?: string | null,
) {
  return db.transaction(async (tx) => {
    const [proposal] = await tx
      .select()
      .from(priceChangeProposals)
      .where(
        and(
          eq(priceChangeProposals.id, proposalId),
          eq(priceChangeProposals.businessId, businessId),
        ),
      )
      .for("update");
    if (!proposal) throw new NotFoundError("Proposal not found.");
    if (proposal.status !== "pending") {
      throw new ConflictError(`Proposal is ${proposal.status}, not pending.`);
    }

    if (decision === "reject") {
      const [updated] = await tx
        .update(priceChangeProposals)
        .set({
          status: "rejected",
          decidedBy: actorUserId,
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(priceChangeProposals.id, proposalId))
        .returning();
      await recordAuditInTx(tx as never, {
        businessId,
        actorUserId,
        action: "pricing.proposal.rejected",
        entityType: "price_change_proposal",
        entityId: proposalId,
        metadata: { variantId: proposal.variantId },
      });
      return updated;
    }

    // Approve = recompute NOW and compare: a stale proposal must never write
    // an out-of-date price (regenerate instead).
    const rec = await recommendForVariant(tx, businessId, proposal.variantId);
    if (
      rec.recommended == null ||
      rec.recommended !== Number(proposal.recommendedPrice)
    ) {
      await tx
        .update(priceChangeProposals)
        .set({ status: "stale", updatedAt: new Date() })
        .where(eq(priceChangeProposals.id, proposalId));
      throw new ConflictError(
        "The recommendation moved since this proposal was generated — regenerate proposals and review again.",
      );
    }

    if (rec.recommended === rec.oldPrice) {
      const [updated] = await tx
        .update(priceChangeProposals)
        .set({
          status: "applied",
          decidedBy: actorUserId,
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(priceChangeProposals.id, proposalId))
        .returning();
      return updated;
    }

    await materializePrice(tx, {
      businessId,
      actorUserId,
      variantId: proposal.variantId,
      oldPrice: rec.oldPrice,
      newPrice: rec.recommended,
      cost: rec.cost,
      ruleId: rec.ruleId,
      source: "proposal",
      proposalId,
      reason: reason ?? null,
      auditAction: "pricing.price.proposal_applied",
    });
    const [updated] = await tx
      .update(priceChangeProposals)
      .set({
        status: "applied",
        decidedBy: actorUserId,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(priceChangeProposals.id, proposalId))
      .returning();
    return updated;
  });
}

export async function bulkApproveProposals(
  businessId: number,
  actorUserId: number | null,
  ids: number[],
): Promise<{ applied: number[]; failed: { id: number; error: string }[] }> {
  const applied: number[] = [];
  const failed: { id: number; error: string }[] = [];
  for (const id of ids) {
    try {
      await decideProposal(businessId, actorUserId, id, "approve");
      applied.push(id);
    } catch (err) {
      failed.push({
        id,
        error: err instanceof Error ? err.message : "Unknown error.",
      });
    }
  }
  return { applied, failed };
}

// ---------------------------------------------------------------------------
// Mode B auto-update sweep — opt-in (pricing_settings.auto_update_enabled),
// advisory-lock deduped, fixed-price protected, floor-respecting.
// ---------------------------------------------------------------------------

export async function runAutoUpdateSweep(
  businessId: number,
  actorUserId: number | null,
): Promise<{
  applied: number;
  skipped: number;
  blocked: { variantId: number; reason: string }[];
  unchanged: number;
}> {
  const settings = await getPricingSettingsView(businessId);
  if (!settings.autoUpdateEnabled) {
    throw new ConflictError(
      "Auto-update is disabled — enable it in Pricing Settings first.",
    );
  }

  return db.transaction(async (tx) => {
    // Dedupe: a second concurrent sweep is REJECTED, not queued (report §12.8).
    const lock = await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtext(${`pricing-auto-update:${businessId}`})) AS acquired`,
    );
    const acquired = (lock.rows[0] as { acquired: boolean } | undefined)?.acquired;
    if (!acquired) {
      throw new ConflictError("An auto-update sweep is already running.");
    }

    const variantIds = await ruleCoveredVariantIds(tx, businessId);

    let applied = 0;
    let skipped = 0;
    let unchanged = 0;
    const blocked: { variantId: number; reason: string }[] = [];

    for (const variantId of variantIds) {
      const rec = await recommendForVariant(tx, businessId, variantId);
      // Fixed-price protection: manually-managed fixed prices are never
      // swept unless the business explicitly enabled it.
      if (rec.isFixedSource && !settings.autoUpdateFixedPrices) {
        skipped++;
        continue;
      }
      if (rec.recommended == null) {
        if (rec.blockedReason) {
          blocked.push({ variantId, reason: rec.blockedReason });
        } else {
          unchanged++;
        }
        continue;
      }
      if (rec.blockedReason) {
        blocked.push({ variantId, reason: rec.blockedReason });
        continue;
      }
      if (rec.recommended === rec.oldPrice) {
        unchanged++;
        continue;
      }
      await materializePrice(tx, {
        businessId,
        actorUserId,
        variantId,
        oldPrice: rec.oldPrice,
        newPrice: rec.recommended,
        cost: rec.cost,
        ruleId: rec.ruleId,
        source: "auto_update",
        reason: null,
        auditAction: "pricing.price.auto_updated",
      });
      applied++;
    }

    await recordAuditInTx(tx as never, {
      businessId,
      actorUserId,
      action: "pricing.auto_update.run",
      entityType: "pricing",
      entityId: null,
      metadata: { scanned: variantIds.length, applied, skipped, blocked: blocked.length, unchanged },
    });
    return { applied, skipped, blocked, unchanged };
  });
}
