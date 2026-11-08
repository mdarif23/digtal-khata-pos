import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { pricingSettings } from "../../db/schema/pricing.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { BadRequestError, NotFoundError } from "../../utils/handleError.js";
import {
  evaluateMinimumPrice,
  finalizeRecommendedPrice,
  computeRecommendedPrice,
  type PricingConfiguration,
} from "./pricing.engine.js";
import { resolveVariantCost } from "./pricing.costProvider.js";
import {
  loadResolutionContext,
  resolveFromContext,
  type ResolvedPricingSource,
} from "./pricing.resolution.js";
import {
  pricingSettingsStrictSchema,
  type PricingSettingsUpdate,
} from "./pricing.validation.js";
import type {
  RoundingDirection,
  RoundingIncrement,
} from "./pricing.money.js";

/**
 * Pricing service — Phase 1 (settings + preview; report §14/§18). Rules CRUD,
 * materialization and history land in later phases; this module already keeps
 * the effective-price separation: EVERYTHING here only READS state, computes,
 * and returns — nothing persists except the settings row itself.
 */

// ---------------------------------------------------------------------------
// Settings (singleton per business, posSettings pattern: absent row = defaults)
// ---------------------------------------------------------------------------

export interface PricingSettingsView {
  defaultMethod: "fixed" | "markup" | "margin";
  defaultPercentage: number | null;
  roundingIncrement: RoundingIncrement;
  roundingDirection: RoundingDirection;
  autoUpdateEnabled: boolean;
  autoUpdateFixedPrices: boolean;
  minMarginPercent: number | null;
  updatedAt: Date | null;
}

export const PRICING_SETTINGS_DEFAULTS: PricingSettingsView = {
  defaultMethod: "fixed",
  defaultPercentage: null,
  roundingIncrement: "none",
  roundingDirection: "nearest",
  autoUpdateEnabled: false,
  autoUpdateFixedPrices: false,
  minMarginPercent: null,
  updatedAt: null,
};

export async function getPricingSettingsView(
  businessId: number,
): Promise<PricingSettingsView> {
  const [row] = await db
    .select()
    .from(pricingSettings)
    .where(eq(pricingSettings.businessId, businessId))
    .limit(1);
  if (!row) return { ...PRICING_SETTINGS_DEFAULTS };
  return {
    defaultMethod: row.defaultMethod as PricingSettingsView["defaultMethod"],
    defaultPercentage:
      row.defaultPercentage == null ? null : Number(row.defaultPercentage),
    roundingIncrement:
      row.roundingIncrement as PricingSettingsView["roundingIncrement"],
    roundingDirection:
      row.roundingDirection as PricingSettingsView["roundingDirection"],
    autoUpdateEnabled: row.autoUpdateEnabled,
    autoUpdateFixedPrices: row.autoUpdateFixedPrices,
    minMarginPercent:
      row.minMarginPercent == null ? null : Number(row.minMarginPercent),
    updatedAt: row.updatedAt,
  };
}

export async function upsertPricingSettings(
  businessId: number,
  payload: PricingSettingsUpdate,
): Promise<PricingSettingsView> {
  const current = await getPricingSettingsView(businessId);
  // Merge onto the current view, then validate the WHOLE object so partial
  // updates cannot dodge the fixed⇔percentage / margin<100 cross-field rules.
  const merged = {
    defaultMethod: payload.defaultMethod ?? current.defaultMethod,
    defaultPercentage:
      payload.defaultPercentage !== undefined
        ? payload.defaultPercentage
        : current.defaultPercentage,
    roundingIncrement: payload.roundingIncrement ?? current.roundingIncrement,
    roundingDirection: payload.roundingDirection ?? current.roundingDirection,
    autoUpdateEnabled: payload.autoUpdateEnabled ?? current.autoUpdateEnabled,
    autoUpdateFixedPrices:
      payload.autoUpdateFixedPrices ?? current.autoUpdateFixedPrices,
    minMarginPercent:
      payload.minMarginPercent !== undefined
        ? payload.minMarginPercent
        : current.minMarginPercent,
  };
  const parsed = pricingSettingsStrictSchema.safeParse(merged);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid pricing settings: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const [row] = await db
    .insert(pricingSettings)
    .values({
      businessId,
      defaultMethod: parsed.data.defaultMethod,
      defaultPercentage: parsed.data.defaultPercentage,
      roundingIncrement: parsed.data.roundingIncrement,
      roundingDirection: parsed.data.roundingDirection,
      autoUpdateEnabled: parsed.data.autoUpdateEnabled,
      autoUpdateFixedPrices: parsed.data.autoUpdateFixedPrices,
      minMarginPercent: parsed.data.minMarginPercent,
    })
    .onConflictDoUpdate({
      target: pricingSettings.businessId,
      set: {
        defaultMethod: parsed.data.defaultMethod,
        defaultPercentage: parsed.data.defaultPercentage,
        roundingIncrement: parsed.data.roundingIncrement,
        roundingDirection: parsed.data.roundingDirection,
        autoUpdateEnabled: parsed.data.autoUpdateEnabled,
        autoUpdateFixedPrices: parsed.data.autoUpdateFixedPrices,
        minMarginPercent: parsed.data.minMarginPercent,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("Pricing settings upsert returned no row.");
  return {
    defaultMethod: row.defaultMethod as PricingSettingsView["defaultMethod"],
    defaultPercentage:
      row.defaultPercentage == null ? null : Number(row.defaultPercentage),
    roundingIncrement:
      row.roundingIncrement as PricingSettingsView["roundingIncrement"],
    roundingDirection:
      row.roundingDirection as PricingSettingsView["roundingDirection"],
    autoUpdateEnabled: row.autoUpdateEnabled,
    autoUpdateFixedPrices: row.autoUpdateFixedPrices,
    minMarginPercent:
      row.minMarginPercent == null ? null : Number(row.minMarginPercent),
    updatedAt: row.updatedAt,
  };
}

/** The settings row as the engine configuration (fallback layer). */
function settingsViewToConfiguration(view: PricingSettingsView): PricingConfiguration {
  return {
    method: view.defaultMethod,
    percentage: view.defaultPercentage,
    fixedPrice: null,
  };
}

// ---------------------------------------------------------------------------
// Preview — never persists; the effective price stays product_variants.
// selling_price until the materialization endpoint is called (Phase 2).
// ---------------------------------------------------------------------------

export type PreviewSource =
  | ResolvedPricingSource
  | { kind: "request_override"; ruleId: null; label: string };

export interface PricingPreviewRow {
  variantId: number;
  productId: number;
  productName: string;
  sku: string;
  /** Current effective price (the field the POS charges). */
  currentSellingPrice: number;
  /** Explicit per-variant floor (null = none). */
  minSellingPrice: number | null;
  /** Where the configuration came from (rule precedence → settings default → what-if). */
  source: PreviewSource;
  method: "fixed" | "markup" | "margin";
  percentage: number | null;
  fixedPrice: number | null;
  costStatus: "available" | "unavailable" | "not_required";
  /** 6-dp weighted-avg landed cost when available (permission-gated upstream). */
  cost: number | null;
  /** Recommended price after final-stage rounding; null when not computable. */
  recommendedPrice: number | null;
  unavailableReason: string | null;
  minimumViolations: ("minimum_price" | "minimum_margin")[];
}

export async function previewVariantPricing(
  businessId: number,
  input: {
    variantIds: number[];
    method?: "fixed" | "markup" | "margin" | undefined;
    percentage?: number | null | undefined;
    fixedPrice?: number | null | undefined;
  },
): Promise<PricingPreviewRow[]> {
  const settings = await getPricingSettingsView(businessId);
  const context = await loadResolutionContext(db, businessId);
  const overrideProvided = input.method !== undefined;
  const overrideConfig: PricingConfiguration | null = overrideProvided
    ? {
        method: input.method!,
        percentage: input.method === "fixed" ? null : (input.percentage ?? null),
        fixedPrice:
          input.method === "fixed" ? (input.fixedPrice ?? null) : null,
      }
    : null;
  const OVERRIDE_SOURCE: PreviewSource = {
    kind: "request_override",
    ruleId: null,
    label: "Request override",
  };

  const variantIds = [...new Set(input.variantIds)];
  const variantRows = await db
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
        eq(productVariants.businessId, businessId),
        inArray(productVariants.id, variantIds),
      ),
    );
  const byId = new Map(variantRows.map((row) => [row.id, row]));

  const rows: PricingPreviewRow[] = [];
  for (const variantId of variantIds) {
    const variant = byId.get(variantId);
    if (!variant) {
      throw new NotFoundError(`Variant ${variantId} not found.`);
    }

    const resolved = overrideConfig
      ? { config: overrideConfig, source: OVERRIDE_SOURCE }
      : resolveFromContext(context, {
          id: variant.id,
          productId: variant.productId,
          categoryId: variant.categoryId,
        });
    const config = resolved.config;

    const needsCost = config.method !== "fixed";
    let costMicros: bigint | null = null;
    let cost: number | null = null;
    let costStatus: PricingPreviewRow["costStatus"] = "not_required";
    let unavailableReason: string | null = null;

    if (needsCost) {
      // The selling price is business-global — cost basis is the global
      // weighted average (no location narrowing), same as materialization.
      const resolution = await resolveVariantCost(db, businessId, variantId, null);
      if (resolution.status === "available") {
        costMicros = resolution.costMicros;
        cost = resolution.cost;
        costStatus = "available";
      } else {
        costStatus = "unavailable";
        unavailableReason = resolution.reason;
      }
    }

    const engineResult = computeRecommendedPrice(config, costMicros);
    const finalized = finalizeRecommendedPrice(
      engineResult,
      settings.roundingIncrement,
      settings.roundingDirection,
    );

    let minimumViolations: PricingPreviewRow["minimumViolations"] = [];
    const recommendedPrice =
      finalized.status === "ok" ? finalized.price : null;
    if (recommendedPrice != null) {
      // Cost is rounded to poisha for the floor check (the engine's exact
      // micros cost is what computed the price; the floor compares money).
      const check = evaluateMinimumPrice({
        price: recommendedPrice,
        cost: cost == null ? null : Math.round(cost * 100) / 100,
        minSellingPrice:
          variant.minSellingPrice == null
            ? null
            : Number(variant.minSellingPrice),
        minMarginPercent: settings.minMarginPercent,
      });
      minimumViolations = check.violations;
    }

    rows.push({
      variantId,
      productId: variant.productId,
      productName: variant.productName,
      sku: variant.sku,
      currentSellingPrice: Number(variant.sellingPrice),
      minSellingPrice:
        variant.minSellingPrice == null
          ? null
          : Number(variant.minSellingPrice),
      source: resolved.source,
      method: config.method,
      percentage: config.percentage,
      fixedPrice: config.fixedPrice,
      costStatus,
      cost,
      recommendedPrice,
      unavailableReason,
      minimumViolations,
    });
  }
  return rows;
}
