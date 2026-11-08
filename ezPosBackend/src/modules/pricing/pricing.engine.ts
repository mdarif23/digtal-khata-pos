/**
 * Pricing calculation engine — PURE module (no DB, no request context).
 *
 * Markup and margin are DIFFERENT formulas (master prompt §5.1/§5.2):
 *   markup:  price = cost × (1 + pct/100)          → cost × (100000 + milli) / 100000
 *   margin:  price = cost / (1 − pct/100)          → cost × 100000 / (100000 − milli)
 * margin ≥ 100 is a division by zero and is REJECTED (never clamped).
 *
 * All arithmetic is BigInt micros (see pricing.money.ts). The engine returns
 * an UNROUNDED price; rounding to the business's configured grid happens
 * exactly once at the final pricing stage (applyFinalRounding) — never inside
 * this module.
 *
 * A missing cost is never silently substituted with zero: percentage methods
 * get an explicit cost_unavailable result (master prompt Part 8).
 */

import {
  HUNDRED_PERCENT_MILLI,
  applyFinalRounding,
  divRoundHalfUp,
  microsToMoney,
  moneyToMicros,
  moneyPercentToMilliUnits,
  percentToMilliUnits,
  type RoundingDirection,
  type RoundingIncrement,
} from "./pricing.money.js";

export type PricingMethod = "fixed" | "markup" | "margin";

/** A resolved pricing rule/settings configuration. */
export interface PricingConfiguration {
  method: PricingMethod;
  /** Percent for markup/margin; REQUIRED NULL for fixed (mirrors the DB CHECKs). */
  percentage: number | null;
  /** Fixed selling price for method 'fixed'; REQUIRED NULL otherwise. */
  fixedPrice: number | null;
}

export type EngineResult =
  | {
      status: "ok";
      method: PricingMethod;
      /** Unrounded price in micros (finalize with applyFinalRounding). */
      priceMicros: bigint;
    }
  | { status: "invalid"; reason: string }
  | { status: "cost_unavailable"; reason: string };

/**
 * Compute the unrounded recommended price in micros from a configuration and
 * an effective unit cost (micros, or null when no priced inventory exists).
 * `fixed` needs no cost; markup/margin need one.
 */
export function computeRecommendedPrice(
  config: PricingConfiguration,
  costMicros: bigint | null,
): EngineResult {
  if (config.method === "fixed") {
    const fixed = config.fixedPrice;
    if (fixed == null || !Number.isFinite(fixed) || fixed < 0) {
      return { status: "invalid", reason: "Fixed price configuration is missing or invalid." };
    }
    return { status: "ok", method: "fixed", priceMicros: moneyToMicros(fixed) };
  }

  if (config.percentage == null || !Number.isFinite(config.percentage)) {
    return {
      status: "invalid",
      reason: "Percentage configuration is missing for a percentage method.",
    };
  }
  const milli = percentToMilliUnits(config.percentage);
  if (milli < 0n) {
    return { status: "invalid", reason: "Percentage cannot be negative." };
  }
  if (config.method === "margin" && milli >= HUNDRED_PERCENT_MILLI) {
    return {
      status: "invalid",
      reason: "Margin percentage must be below 100%.",
    };
  }
  if (costMicros == null || costMicros < 0n) {
    return {
      status: "cost_unavailable",
      reason:
        "No priced inventory cost is available for this variant — a percentage price cannot be calculated.",
    };
  }
  if (config.method === "markup") {
    return {
      status: "ok",
      method: "markup",
      priceMicros: divRoundHalfUp(
        costMicros * (HUNDRED_PERCENT_MILLI + milli),
        HUNDRED_PERCENT_MILLI,
      ),
    };
  }
  // margin: price = cost × 100000 / (100000 − milli); milli < 100000 here.
  return {
    status: "ok",
    method: "margin",
    priceMicros: divRoundHalfUp(
      costMicros * HUNDRED_PERCENT_MILLI,
      HUNDRED_PERCENT_MILLI - milli,
    ),
  };
}

/**
 * Round an engine result to the final effective price (2-dp money), applying
 * the business rounding configuration ONCE (master prompt Part 10).
 */
export function finalizeRecommendedPrice(
  result: EngineResult,
  increment: RoundingIncrement,
  direction: RoundingDirection,
): { status: "ok"; price: number } | { status: "invalid" | "cost_unavailable"; reason: string } {
  if (result.status !== "ok") {
    return { status: result.status, reason: result.reason };
  }
  const rounded = applyFinalRounding(result.priceMicros, increment, direction);
  return { status: "ok", price: microsToMoney(rounded) };
}

// ---------------------------------------------------------------------------
// Minimum-price protection (master prompt Part 11)
// ---------------------------------------------------------------------------

export type MinimumPriceViolation = "minimum_price" | "minimum_margin";

export interface MinimumPriceInput {
  /** Candidate selling price (2-dp money). */
  price: number;
  /** Effective unit cost when available (2-dp money otherwise null). */
  cost: number | null;
  /** Per-variant explicit floor. */
  minSellingPrice?: number | null;
  /** Business-wide margin floor (percent). */
  minMarginPercent?: number | null;
}

export interface MinimumPriceResult {
  violated: boolean;
  violations: MinimumPriceViolation[];
  /** profit = price − cost in micros; null when cost unknown. */
  profitMicros: bigint | null;
}

/**
 * Evaluate a candidate price against the configured floors. Never fabricates
 * a cost: when cost is unknown the margin floor simply cannot be evaluated.
 */
export function evaluateMinimumPrice(input: MinimumPriceInput): MinimumPriceResult {
  const violations: MinimumPriceViolation[] = [];
  const pricePoisha = BigInt(Math.round(input.price * 100));
  const costPoisha =
    input.cost != null ? BigInt(Math.round(input.cost * 100)) : null;
  const profitMicros =
    costPoisha != null ? (pricePoisha - costPoisha) * 10_000n : null;

  if (
    input.minSellingPrice != null &&
    Number.isFinite(input.minSellingPrice) &&
    input.price < input.minSellingPrice
  ) {
    violations.push("minimum_price");
  }

  if (input.minMarginPercent != null && costPoisha != null && pricePoisha > 0n) {
    // margin (milli-percent) = (price − cost) / price × 100 × 1000
    const marginMilli = ((pricePoisha - costPoisha) * 100_000n) / pricePoisha;
    const floorMilli = moneyPercentToMilliUnits(input.minMarginPercent);
    if (marginMilli < floorMilli) {
      violations.push("minimum_margin");
    }
  }

  return { violated: violations.length > 0, violations, profitMicros };
}
