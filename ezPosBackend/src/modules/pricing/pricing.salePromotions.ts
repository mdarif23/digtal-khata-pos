import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import {
  customerGroups,
  pricingPromotions,
  promotionCustomerGroups,
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
 * Auto-applied promotion evaluation at SALE TIME (Phase 5, approved design
 * §13.6/§18). Server-side only — quote and createSale share identical rules
 * (the coupons and group-pricing engine pattern). Promotions are NEVER
 * permission-gated: they are store configuration that applies by itself.
 *
 * STACKING POLICY (approved §12.2, deterministic):
 * - Application order: base price → group discount → promotions → manual
 *   discounts → VAT. Promotion amounts are computed on the POST-GROUP bases.
 * - A promotion stacks with an applied GROUP discount only when BOTH sides
 *   consent: `canStackWithGroupDiscount` on the promotion AND
 *   `stacksWithPromotions` on every applied group-pricing row. Otherwise the
 *   promotion is skipped entirely (the automatic group layer wins).
 * - A promotion stacks with a COUPON only when `canStackWithCoupons` is set;
 *   otherwise it is skipped when the cart carries a coupon. The coupon's
 *   min-order/percentage base is the post-group-post-promotion total
 *   (the engine's afterDiscount).
 * - Walk-in customers get promotions with NO group restriction; a promotion
 *   restricted via promotion_customer_groups applies only to members of the
 *   listed groups.
 */

export interface AppliedPromotion {
  id: number;
  name: string;
  amount: number;
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
}

const NONE: SalePromotionResult = {
  cartAmounts: [],
  lineAdjustments: [],
  applied: [],
  total: 0,
};

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
}

interface EvalItem {
  variantId: number;
  quantity: number;
  unitPrice: number;
  discount: DiscountInput;
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
 * (same order) passed to the cart engine; `group` is the Phase-4 evaluation
 * of the same cart so promotion bases are post-group. Returns line-scoped
 * amounts computed on post-group line totals and whole-cart amounts the
 * engine allocates pro-rata over those same post-group totals.
 */
export async function evaluateSalePromotions(
  dbe: Pick<typeof db, "select">,
  businessId: number,
  items: EvalItem[],
  group: SaleGroupPricing,
  hasCoupon: boolean,
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

  // --- Variant → product/category map for scoped matching (one query) -----
  const variantIds = [...new Set(items.map((i) => i.variantId))];
  const variantRows = await dbe
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      categoryId: products.categoryId,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productVariants.businessId, businessId));
  const scopeById = new Map(
    variantRows
      .filter((v) => variantIds.includes(v.id))
      .map((v) => [v.id, { productId: v.productId, categoryId: v.categoryId }]),
  );

  const itemsQuantity = items.reduce((sum, item) => sum + item.quantity, 0);

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
      }),
    )
    .filter((row) => {
      // Server-side window + minimums (min order measured POST-group).
      if (row.startsAt && row.startsAt > now) return false;
      if (row.endsAt && row.endsAt < now) return false;
      if (row.minOrderValue > postGroupCartTotal) return false;
      if (row.minQuantity != null && row.minQuantity > itemsQuantity) return false;
      // Stacking consent with the applied group layer.
      if (groupApplied) {
        if (!row.canStackWithGroupDiscount) return false;
        if (!group.stacksWithPromotions) return false;
      }
      // Stacking consent with a coupon present in the cart.
      if (hasCoupon && !row.canStackWithCoupons) return false;
      // Customer-group restriction: rows = listed (active) groups only.
      const restrictions = restrictionsByPromo.get(row.id);
      if (restrictions && restrictions.size > 0) {
        if (group.groupId == null || !restrictions.has(group.groupId)) {
          return false;
        }
      }
      return true;
    });
  if (eligible.length === 0) return NONE;

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

  const cartAmounts: CartGroupAmount[] = [];
  const lineAdjustments: (CartGroupAmount | null)[] = items.map(() => null);
  const applied: AppliedPromotion[] = [];
  let total = 0;

  for (const row of eligible) {
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

    // Scoped rows: apply to the matching lines on their POST-GROUP totals,
    // cap the row's AGGREGATE at maxDiscountAmount via proportional scaling
    // (last matching line absorbs the remainder).
    const matches: number[] = [];
    items.forEach((item, idx) => {
      const scope = scopeById.get(item.variantId);
      if (!scope) return;
      if (
        row.scopeVariantId != null
          ? row.scopeVariantId === item.variantId
          : row.scopeProductId != null
            ? row.scopeProductId === scope.productId
            : row.scopeCategoryId != null && row.scopeCategoryId === scope.categoryId
      ) {
        matches.push(idx);
      }
    });
    if (matches.length === 0) continue;

    const raw = matches.map((idx) => ({
      idx,
      amount: computeAmount(row, postGroupTotals[idx]!),
    }));
    const rawTotal = roundMoney(raw.reduce((sum, r) => sum + r.amount, 0));
    const cap = row.maxDiscountAmount;
    let scaled = raw;
    if (cap != null && rawTotal > roundMoney(cap)) {
      const scale = cap / rawTotal;
      scaled = raw.map((r) => ({ idx: r.idx, amount: roundMoney(r.amount * scale) }));
      const scaledTotal = roundMoney(scaled.reduce((s, r) => s + r.amount, 0));
      const last = scaled[scaled.length - 1]!;
      last.amount = roundMoney(last.amount + (roundMoney(cap) - scaledTotal));
    }
    let rowApplied = 0;
    for (const r of scaled) {
      if (r.amount <= 0) continue;
      const existing = lineAdjustments[r.idx];
      lineAdjustments[r.idx] = {
        refId: row.id,
        amount: roundMoney((existing?.amount ?? 0) + r.amount),
      };
      rowApplied = roundMoney(rowApplied + r.amount);
    }
    if (rowApplied > 0) {
      total = roundMoney(total + rowApplied);
      applied.push({ id: row.id, name: row.name, amount: rowApplied });
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

  if (total <= 0 && applied.length === 0) return NONE;
  return { cartAmounts, lineAdjustments, applied, total };
}

/** Engine input shaped from an evaluation (keeps the call sites terse). */
export function toCartPromotionInput(
  evaluation: SalePromotionResult,
): CartPromotionInput {
  if (evaluation.applied.length === 0) return EMPTY_PROMOTION_INPUT;
  return {
    cartAmounts: evaluation.cartAmounts,
    lineAdjustments: evaluation.lineAdjustments,
  };
}
