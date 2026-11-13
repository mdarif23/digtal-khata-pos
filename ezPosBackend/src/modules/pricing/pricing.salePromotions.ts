import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import {
  customerGroups,
  pricingPromotions,
  promotionCustomerGroups,
  promotionUsage,
} from "../../db/schema/pricing.js";
import { roundMoney } from "../../utils/roundMoney.js";
import type { DiscountInput } from "../sales/utils/cartPricing.js";
import {
  allocateProRata,
  EMPTY_PROMOTION_INPUT,
  type CartGroupAmount,
  type CartPromotionInput,
} from "../sales/utils/cartPricing.js";
import type { SaleGroupPricing } from "./pricing.salePricing.js";

/**
 * Auto-applied promotion evaluation at SALE TIME. Server-side only — quote
 * and createSale share identical rules (the coupons and group-pricing
 * engine pattern). Promotions are NEVER permission-gated: they are store
 * configuration that applies by itself.
 *
 * STACKING POLICY (approved §12.2, deterministic):
 * - Application order: base price → group discount → promotions (priority
 *   DESC, id ASC) → manual discounts → VAT. Amounts are computed on the
 *   POST-GROUP bases.
 * - A promotion stacks with an applied GROUP discount only when BOTH sides
 *   consent; a promotion stacks with a COUPON only when it consents.
 * - Walk-in customers get promotions with NO group restriction.
 *
 * PHASE 3 (master prompt Feature 8): promo kinds discount (legacy) | bogo |
 * buy_x_get_y | mix_match | quantity_tier with per-kind rule jsonb; flash
 * windows (day-of-week + time-of-day, Asia/Dhaka UTC+6); location scope;
 * usage limits (total + per-customer, idempotent per sale via
 * promotion_usage); near-miss discovery for the POS offer strip.
 */

export interface AppliedPromotion {
  id: number;
  name: string;
  amount: number;
}

export interface PromotionNearMiss {
  id: number;
  name: string;
  reason: string;
}

export interface SalePromotionResult {
  /** Whole-cart amounts (engine allocates pro-rata on post-group totals). */
  cartAmounts: CartGroupAmount[];
  /** Line-scoped amounts, INDEX-ALIGNED with the items array. */
  lineAdjustments: (CartGroupAmount | null)[];
  /** What actually applied, for the quote response and snapshots. */
  applied: AppliedPromotion[];
  /** Total promotion discount (roundMoney'd). */
  total: number;
  /** Promotions the cart ALMOST qualifies for — POS offer strip. */
  nearMisses: PromotionNearMiss[];
}

const NONE: SalePromotionResult = {
  cartAmounts: [],
  lineAdjustments: [],
  applied: [],
  total: 0,
  nearMisses: [],
};

type PromoKind = "discount" | "bogo" | "buy_x_get_y" | "mix_match" | "quantity_tier";

interface PromoRow {
  id: number;
  name: string;
  scopeCategoryId: number | null;
  scopeProductId: number | null;
  scopeVariantId: number | null;
  discountType: string;
  discountValue: number;
  startsAt: Date | null;
  endsAt: Date | null;
  minQuantity: number | null;
  minOrderValue: number;
  maxDiscountAmount: number | null;
  canStackWithGroupDiscount: boolean;
  canStackWithCoupons: boolean;
  promoKind: PromoKind;
  rule: Record<string, unknown> | null;
  daysOfWeek: number[] | null;
  startTime: string | null;
  endTime: string | null;
  locationId: number | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  priority: number;
}

interface EvalItem {
  variantId: number;
  quantity: number;
  unitPrice: number;
  discount: DiscountInput;
}

/** Asia/Dhaka wall-clock (fixed UTC+6, no DST) for flash windows. */
function dhakaNow(now: Date): { dayOfWeek: number; hhmm: string } {
  const shifted = new Date(now.getTime() + 6 * 3_600_000);
  const dayOfWeek = shifted.getUTCDay();
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return { dayOfWeek, hhmm: `${hh}:${mm}` };
}

function parseRuleNumber(
  rule: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = rule?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function lineTotalOf(item: EvalItem): number {
  const base = roundMoney(item.unitPrice * item.quantity);
  const raw =
    item.discount?.type === "percentage"
      ? (base * Math.min(item.discount.value, 100)) / 100
      : item.discount?.type === "fixed"
        ? item.discount.value
        : 0;
  return roundMoney(Math.max(0, base - roundMoney(Math.min(Math.max(raw, 0), base))));
}

/**
 * Evaluate the promotion layer for a cart. `items` must be the SAME array
 * (same order) passed to the cart engine; `group` is the group evaluation
 * of the same cart so promotion bases are post-group.
 */
export async function evaluateSalePromotions(
  dbe: Pick<typeof db, "select">,
  businessId: number,
  items: EvalItem[],
  group: SaleGroupPricing,
  hasCoupon: boolean,
  context: {
    locationId: number | null;
    customerId: number | null;
  } = { locationId: null, customerId: null },
): Promise<SalePromotionResult> {
  if (items.length === 0) return NONE;

  const preGroupTotals = items.map(lineTotalOf);
  const itemsTotal = roundMoney(preGroupTotals.reduce((sum, t) => sum + t, 0));

  // Post-group line totals: replicate the engine's group allocation exactly
  // (whole-cart rows pro-rata by pre-group line totals + line-scoped verbatim)
  // so evaluator and engine never disagree about a base.
  const groupAllocPerLine = new Array<number>(items.length).fill(0);
  for (const cartRow of group.cartAmounts) {
    const allocs = allocateProRata(preGroupTotals, roundMoney(cartRow.amount));
    allocs.forEach((a, idx) => {
      groupAllocPerLine[idx] = roundMoney(groupAllocPerLine[idx]! + a);
    });
  }
  group.lineAdjustments.forEach((adj, idx) => {
    if (adj && adj.amount > 0) {
      groupAllocPerLine[idx] = roundMoney(groupAllocPerLine[idx]! + adj.amount);
    }
  });
  const postGroupTotals = preGroupTotals.map((total, idx) =>
    Math.max(0, roundMoney(total - groupAllocPerLine[idx]!)),
  );
  const postGroupCartTotal = roundMoney(
    postGroupTotals.reduce((sum, t) => sum + t, 0),
  );
  const groupApplied = group.total > 0;

  // --- Load active promotions (one query) ---------------------------------
  const now = new Date();
  const rows = (await dbe
    .select()
    .from(pricingPromotions)
    .where(
      and(
        eq(pricingPromotions.businessId, businessId),
        eq(pricingPromotions.isActive, true),
      ),
    )) as unknown as (typeof pricingPromotions.$inferSelect)[];
  if (rows.length === 0) return NONE;

  const promoIds = rows.map((r) => r.id);
  const restrictionRows = await dbe
    .select({
      promotionId: promotionCustomerGroups.promotionId,
      groupId: promotionCustomerGroups.groupId,
      groupIsActive: customerGroups.isActive,
    })
    .from(promotionCustomerGroups)
    .innerJoin(
      customerGroups,
      and(
        eq(
          promotionCustomerGroups.groupId,
          customerGroups.id,
        ),
        eq(promotionCustomerGroups.businessId, customerGroups.businessId),
      ),
    )
    .where(inArray(promotionCustomerGroups.promotionId, promoIds));
  const restrictionsByPromo = new Map<number, Set<number>>();
  for (const row of restrictionRows) {
    if (!row.groupIsActive) continue;
    const set = restrictionsByPromo.get(row.promotionId) ?? new Set<number>();
    set.add(row.groupId);
    restrictionsByPromo.set(row.promotionId, set);
  }

  // Usage counters (one grouped query; per-customer counts via CASE sum).
  const usageTotals = new Map<number, number>();
  const usageByCustomer = new Map<number, number>();
  const usageRows = await dbe
    .select({
      promotionId: promotionUsage.promotionId,
      total: sql<string>`COUNT(*)`,
      forCustomer: sql<string>`SUM(CASE WHEN ${promotionUsage.customerId} = ${context.customerId ?? -1} THEN 1 ELSE 0 END)`,
    })
    .from(promotionUsage)
    .where(
      and(
        eq(promotionUsage.businessId, businessId),
        inArray(promotionUsage.promotionId, promoIds),
      ),
    )
    .groupBy(promotionUsage.promotionId);
  for (const row of usageRows) {
    usageTotals.set(row.promotionId, Number(row.total));
    usageByCustomer.set(row.promotionId, Number(row.forCustomer));
  }

  // --- Variant → product/category map for scoped matching ------------------
  // Perf fix: only the CART's variants (was: every business variant on
  // every checkout — O(catalog)).
  const variantIds = [...new Set(items.map((i) => i.variantId))];
  const variantRows = await dbe
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      categoryId: products.categoryId,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(productVariants.businessId, businessId),
        inArray(productVariants.id, variantIds),
      ),
    );
  const scopeById = new Map(
    variantRows.map(
      (v) => [v.id, { productId: v.productId, categoryId: v.categoryId }] as const,
    ),
  );

  const itemsQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const dhaka = dhakaNow(now);

  const nearMisses: PromotionNearMiss[] = [];

  const eligible = rows
    .map(
      (row): PromoRow => ({
        id: row.id,
        name: row.name,
        scopeCategoryId: row.categoryId,
        scopeProductId: row.productId,
        scopeVariantId: row.variantId,
        discountType: row.discountType,
        discountValue: Number(row.discountValue),
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        minQuantity: row.minQuantity,
        minOrderValue: Number(row.minOrderValue),
        maxDiscountAmount:
          row.maxDiscountAmount == null ? null : Number(row.maxDiscountAmount),
        canStackWithGroupDiscount: row.canStackWithGroupDiscount,
        canStackWithCoupons: row.canStackWithCoupons,
        promoKind: (
          ["discount", "bogo", "buy_x_get_y", "mix_match", "quantity_tier"].includes(
            row.promoKind,
          )
            ? row.promoKind
            : "discount"
        ) as PromoKind,
        rule: (row.rule ?? null) as Record<string, unknown> | null,
        daysOfWeek: (row.daysOfWeek ?? null) as number[] | null,
        startTime: row.startTime ?? null,
        endTime: row.endTime ?? null,
        locationId: row.locationId ?? null,
        usageLimit: row.usageLimit ?? null,
        perCustomerLimit: row.perCustomerLimit ?? null,
        priority: row.priority ?? 0,
      }),
    )
    .filter((row) => {
      // Server-side window + minimums (min order measured POST-group).
      if (row.startsAt && row.startsAt > now) {
        nearMisses.push({ id: row.id, name: row.name, reason: "Starts later" });
        return false;
      }
      if (row.endsAt && row.endsAt < now) return false; // quietly ended
      if (
        row.daysOfWeek != null &&
        Array.isArray(row.daysOfWeek) &&
        row.daysOfWeek.length > 0 &&
        !row.daysOfWeek.includes(dhaka.dayOfWeek)
      ) {
        return false; // different day — not a near miss worth showing
      }
      if (row.startTime != null && row.endTime != null) {
        const inWindow =
          row.startTime <= row.endTime
            ? dhaka.hhmm >= row.startTime && dhaka.hhmm <= row.endTime
            : dhaka.hhmm >= row.startTime || dhaka.hhmm <= row.endTime; // overnight
        if (!inWindow) return false;
      }
      if (row.locationId != null && row.locationId !== context.locationId) {
        return false;
      }
      if (row.minOrderValue > postGroupCartTotal) {
        nearMisses.push({
          id: row.id,
          name: row.name,
          reason: `Add ৳${roundMoney(row.minOrderValue - postGroupCartTotal)} more to qualify`,
        });
        return false;
      }
      if (row.minQuantity != null && row.minQuantity > itemsQuantity) {
        nearMisses.push({
          id: row.id,
          name: row.name,
          reason: `Add ${row.minQuantity - itemsQuantity} more item(s)`,
        });
        return false;
      }
      if (row.usageLimit != null && (usageTotals.get(row.id) ?? 0) >= row.usageLimit) {
        return false; // fully redeemed
      }
      if (
        row.perCustomerLimit != null &&
        context.customerId != null &&
        (usageByCustomer.get(row.id) ?? 0) >= row.perCustomerLimit
      ) {
        nearMisses.push({
          id: row.id,
          name: row.name,
          reason: "You already used this offer",
        });
        return false;
      }
      // Stacking consent with the applied group layer.
      if (groupApplied) {
        if (!row.canStackWithGroupDiscount || !group.stacksWithPromotions) {
          return false; // group layer wins — not surfaced as a near miss
        }
      }
      if (hasCoupon && !row.canStackWithCoupons) {
        nearMisses.push({
          id: row.id,
          name: row.name,
          reason: "Not combinable with the coupon",
        });
        return false;
      }
      // Customer-group restriction: rows = listed (active) groups only.
      const restrictions = restrictionsByPromo.get(row.id);
      if (restrictions && restrictions.size > 0) {
        if (group.groupId == null || !restrictions.has(group.groupId)) {
          return false;
        }
      }
      return true;
    })
    // Deterministic, priority-aware application order.
    .sort((a, b) => b.priority - a.priority || a.id - b.id);
  if (eligible.length === 0) {
    return { ...NONE, nearMisses };
  }

  const computeAmount = (
    row: { discountType: string; discountValue: number; maxDiscountAmount: number | null },
    base: number,
  ): number => {
    let amount =
      row.discountType === "percentage"
        ? roundMoney((base * Math.min(row.discountValue, 100)) / 100)
        : roundMoney(row.discountValue);
    amount = Math.min(amount, base);
    if (row.maxDiscountAmount != null) {
      amount = Math.min(amount, roundMoney(row.maxDiscountAmount));
    }
    return roundMoney(Math.max(0, amount));
  };

  /** Whether a cart line matches the row's scope (variant > product > category > cart). */
  const lineMatches = (row: PromoRow, item: EvalItem): boolean => {
    if (
      row.scopeVariantId == null &&
      row.scopeProductId == null &&
      row.scopeCategoryId == null
    ) {
      return true; // whole-cart kind
    }
    const scope = scopeById.get(item.variantId);
    if (!scope) return false;
    if (row.scopeVariantId != null) return row.scopeVariantId === item.variantId;
    if (row.scopeProductId != null) return row.scopeProductId === scope.productId;
    return row.scopeCategoryId != null && row.scopeCategoryId === scope.categoryId;
  };

  const cartAmounts: CartGroupAmount[] = [];
  const lineAdjustments: (CartGroupAmount | null)[] = items.map(() => null);
  const applied: AppliedPromotion[] = [];
  let total = 0;

  const applyLineScoped = (row: PromoRow, amountsByLine: Map<number, number>): void => {
    let rowApplied = 0;
    const entries = [...amountsByLine.entries()].sort((a, b) => a[0] - b[0]);
    for (const [idx, amount] of entries) {
      if (amount <= 0) continue;
      // Never over-discount a line beyond its post-group total.
      const capped = Math.min(amount, postGroupTotals[idx]!);
      if (capped <= 0) continue;
      const existing = lineAdjustments[idx];
      lineAdjustments[idx] = {
        refId: row.id,
        amount: roundMoney((existing?.amount ?? 0) + capped),
      };
      rowApplied = roundMoney(rowApplied + capped);
    }
    if (rowApplied > 0) {
      total = roundMoney(total + rowApplied);
      applied.push({ id: row.id, name: row.name, amount: rowApplied });
    }
  };

  for (const row of eligible) {
    if (row.promoKind === "discount") {
      // Legacy behavior: whole-cart rows price the cart; scoped rows price
      // their matching lines with aggregate max-discount scaling.
      const isWholeCart =
        row.scopeCategoryId == null &&
        row.scopeProductId == null &&
        row.scopeVariantId == null;
      if (isWholeCart) {
        const amount = computeAmount(row, postGroupCartTotal);
        if (amount > 0) {
          cartAmounts.push({ refId: row.id, amount });
          total = roundMoney(total + amount);
          applied.push({ id: row.id, name: row.name, amount });
        }
        continue;
      }
      const amountsByLine = new Map<number, number>();
      const matches: number[] = [];
      items.forEach((item, idx) => {
        if (lineMatches(row, item)) matches.push(idx);
      });
      if (matches.length === 0) continue;
      const raw = matches.map((idx) => ({
        idx,
        amount: computeAmount(row, postGroupTotals[idx]!),
      }));
      const rawTotal = roundMoney(raw.reduce((sum, r) => sum + r.amount, 0));
      const cap = row.maxDiscountAmount;
      if (cap != null && rawTotal > roundMoney(cap)) {
        const scale = cap / rawTotal;
        const scaledTotal = roundMoney(
          raw.reduce((s, r) => s + roundMoney(r.amount * scale), 0),
        );
        raw.forEach((r, i) => {
          let amount = roundMoney(r.amount * scale);
          if (i === raw.length - 1) {
            amount = roundMoney(amount + (roundMoney(cap) - scaledTotal));
          }
          amountsByLine.set(r.idx, amount);
        });
      } else {
        raw.forEach((r) => amountsByLine.set(r.idx, r.amount));
      }
      applyLineScoped(row, amountsByLine);
      continue;
    }

    if (row.promoKind === "bogo") {
      // Buy X get Y free WITHIN each variant group of the scope:
      // freeUnits = floor(qty / (buyQty + getQty)) × getQty, cheapest first.
      const buyQty = parseRuleNumber(row.rule, "buyQty") ?? 1;
      const getQty = parseRuleNumber(row.rule, "getQty") ?? 1;
      const cycle = buyQty + getQty;
      const groups = new Map<number, { idx: number; quantity: number; unitPrice: number }[]>();
      items.forEach((item, idx) => {
        if (!lineMatches(row, item)) return;
        const list = groups.get(item.variantId) ?? [];
        list.push({ idx, quantity: item.quantity, unitPrice: item.unitPrice });
        groups.set(item.variantId, list);
      });
      const amountsByLine = new Map<number, number>();
      for (const [, lines] of groups) {
        const qty = lines.reduce((sum, l) => sum + l.quantity, 0);
        const freeUnits = Math.floor(qty / cycle) * getQty;
        if (freeUnits <= 0) {
          nearMisses.push({
            id: row.id,
            name: row.name,
            reason: `Add ${cycle - (qty % cycle)} more for the deal`,
          });
          continue;
        }
        const units: { idx: number; price: number }[] = [];
        for (const line of lines) {
          for (let u = 0; u < Math.floor(line.quantity); u++) {
            units.push({ idx: line.idx, price: line.unitPrice });
          }
        }
        units.sort((a, b) => a.price - b.price);
        let remaining = freeUnits;
        for (const unit of units) {
          if (remaining <= 0) break;
          amountsByLine.set(
            unit.idx,
            roundMoney((amountsByLine.get(unit.idx) ?? 0) + unit.price),
          );
          remaining -= 1;
        }
      }
      applyLineScoped(row, amountsByLine);
      continue;
    }

    if (row.promoKind === "buy_x_get_y") {
      const buyQty = parseRuleNumber(row.rule, "buyQty") ?? 1;
      const getQty = parseRuleNumber(row.rule, "getQty") ?? 1;
      const getPercent =
        typeof row.rule?.getDiscountPercent === "number"
          ? Math.min(100, Math.max(0, row.rule.getDiscountPercent))
          : 100;
      const buyVariantId = parseRuleNumber(row.rule, "buyVariantId");
      const buyProductId = parseRuleNumber(row.rule, "buyProductId");
      const getVariantId = parseRuleNumber(row.rule, "getVariantId");
      const getProductId = parseRuleNumber(row.rule, "getProductId");
      if (
        (buyVariantId == null && buyProductId == null) ||
        (getVariantId == null && getProductId == null)
      ) {
        continue; // malformed rule — skip silently (configuration error)
      }
      const buyUnits = items
        .filter((item) => {
          const scope = scopeById.get(item.variantId);
          return buyVariantId != null
            ? item.variantId === buyVariantId
            : scope?.productId === buyProductId;
        })
        .reduce((sum, item) => sum + item.quantity, 0);
      const repetitions = Math.floor(buyUnits / buyQty);
      if (repetitions <= 0) {
        nearMisses.push({
          id: row.id,
          name: row.name,
          reason: `Buy ${buyQty} to get the deal`,
        });
        continue;
      }
      const freeUnits = repetitions * getQty;
      const getLines = items
        .map((item, idx) => ({ item, idx }))
        .filter(({ item }) => {
          const scope = scopeById.get(item.variantId);
          return getVariantId != null
            ? item.variantId === getVariantId
            : scope?.productId === getProductId;
        })
        .sort((a, b) => a.item.unitPrice - b.item.unitPrice);
      const amountsByLine = new Map<number, number>();
      let remaining = freeUnits;
      for (const { item, idx } of getLines) {
        if (remaining <= 0) break;
        const take = Math.min(Math.floor(item.quantity), remaining);
        amountsByLine.set(
          idx,
          roundMoney(
            (amountsByLine.get(idx) ?? 0) + item.unitPrice * take * (getPercent / 100),
          ),
        );
        remaining -= take;
      }
      applyLineScoped(row, amountsByLine);
      continue;
    }

    if (row.promoKind === "mix_match") {
      const comboSize = parseRuleNumber(row.rule, "comboSize") ?? 2;
      const percent =
        typeof row.rule?.discountPercent === "number"
          ? Math.min(100, Math.max(0, row.rule.discountPercent))
          : 0;
      if (percent <= 0) continue;
      const units: { idx: number; price: number }[] = [];
      items.forEach((item, idx) => {
        if (!lineMatches(row, item)) return;
        for (let u = 0; u < Math.floor(item.quantity); u++) {
          units.push({ idx, price: item.unitPrice });
        }
      });
      const combos = Math.floor(units.length / comboSize);
      if (combos <= 0) {
        nearMisses.push({
          id: row.id,
          name: row.name,
          reason: `Pick ${comboSize - units.length} more for the combo`,
        });
        continue;
      }
      units.sort((a, b) => a.price - b.price);
      const amountsByLine = new Map<number, number>();
      let remaining = combos * comboSize;
      for (const unit of units) {
        if (remaining <= 0) break;
        amountsByLine.set(
          unit.idx,
          roundMoney((amountsByLine.get(unit.idx) ?? 0) + unit.price * (percent / 100)),
        );
        remaining -= 1;
      }
      applyLineScoped(row, amountsByLine);
      continue;
    }

    if (row.promoKind === "quantity_tier") {
      const tiers = Array.isArray(row.rule?.tiers)
        ? (row.rule.tiers as { minQty?: unknown; discountPercent?: unknown }[])
            .map((t) => ({
              minQty: typeof t.minQty === "number" ? t.minQty : 0,
              discountPercent:
                typeof t.discountPercent === "number"
                  ? Math.min(100, Math.max(0, t.discountPercent))
                  : 0,
            }))
            .filter((t) => t.minQty > 0 && t.discountPercent > 0)
            .sort((a, b) => b.minQty - a.minQty)
        : [];
      if (tiers.length === 0) continue;
      const amountsByLine = new Map<number, number>();
      items.forEach((item, idx) => {
        if (!lineMatches(row, item)) return;
        const tier = tiers.find((t) => item.quantity >= t.minQty);
        if (!tier) {
          nearMisses.push({
            id: row.id,
            name: row.name,
            reason: `Buy ${tiers[tiers.length - 1]!.minQty}+ for tiered savings`,
          });
          return;
        }
        amountsByLine.set(
          idx,
          roundMoney(postGroupTotals[idx]! * (tier.discountPercent / 100)),
        );
      });
      applyLineScoped(row, amountsByLine);
      continue;
    }
  }

  // The promotion layer can never exceed the post-group cart itself.
  if (total > postGroupCartTotal) {
    const scale = postGroupCartTotal / total;
    for (const a of cartAmounts) a.amount = roundMoney(a.amount * scale);
    for (let i = 0; i < lineAdjustments.length; i++) {
      const a = lineAdjustments[i];
      if (a) lineAdjustments[i] = { ...a, amount: roundMoney(a.amount * scale) };
    }
    for (const a of applied) a.amount = roundMoney(a.amount * scale);
    total = postGroupCartTotal;
  }

  if (total <= 0 && applied.length === 0) {
    return { ...NONE, nearMisses };
  }
  return { cartAmounts, lineAdjustments, applied, total, nearMisses };
}

export { EMPTY_PROMOTION_INPUT };

/** Converts the evaluation into the cart engine's promotion input. */
export function toCartPromotionInput(
  evaluation: SalePromotionResult,
): CartPromotionInput {
  if (evaluation.applied.length === 0) return EMPTY_PROMOTION_INPUT;
  return {
    cartAmounts: evaluation.cartAmounts,
    lineAdjustments: evaluation.lineAdjustments,
  };
}
