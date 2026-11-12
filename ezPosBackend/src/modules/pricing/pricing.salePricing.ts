import { and, eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { customers } from "../../db/schema/customers.js";
import {
  customerGroupPricing,
  customerGroups,
} from "../../db/schema/pricing.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { businessLocalDate } from "../../utils/money.js";
import { roundMoney } from "../../utils/roundMoney.js";
import type { DiscountInput } from "../sales/utils/cartPricing.js";
import type { CartGroupAmount } from "../sales/utils/cartPricing.js";
import { EMPTY_GROUP_INPUT, type CartGroupInput } from "../sales/utils/cartPricing.js";
import { businesses } from "../../db/schema/businesses.js";

/**
 * Customer-group pricing evaluation at SALE TIME (Phase 4, report §13.4/§18).
 * Server-side only — quote and createSale share identical rules (the coupons
 * engine pattern). Walk-in customers and customers without an active group
 * get NO group pricing.
 *
 * STACKING POLICY (approved §6 default): base selling price → GROUP discount
 * (automatic, never permission-gated) → eligible promotions (Phase 5) →
 * authorized manual discounts → VAT via the existing engine. This module
 * computes the GROUP layer's final amounts; the cart engine allocates them
 * for tax and snapshots.
 *
 * Group pricing applies to ELIGIBLE SELLING PRICES (line totals after the
 * line's own discount), never to purchase costs.
 */

export interface SaleGroupPricing {
  groupId: number | null;
  groupName: string | null;
  /** Whole-cart amounts (engine allocates pro-rata). */
  cartAmounts: CartGroupAmount[];
  /** Line-scoped amounts, INDEX-ALIGNED with the items array. */
  lineAdjustments: (CartGroupAmount | null)[];
  /** Total group discount (roundMoney'd). */
  total: number;
  /** Phase 5 stacking consent: true when EVERY applied group-pricing row
   * allows promotions to stack (vacuously true when nothing applied). */
  stacksWithPromotions: boolean;
}

const NONE: SaleGroupPricing = {
  groupId: null,
  groupName: null,
  cartAmounts: [],
  lineAdjustments: [],
  total: 0,
  stacksWithPromotions: true,
};

/** Membership without applicable pricing rows: no discount, but the group
 * identity is preserved so promotion group-restrictions still match. */
function membershipWithoutPricing(
  groupId: number,
  groupName: string | null,
): SaleGroupPricing {
  return {
    groupId,
    groupName,
    cartAmounts: [],
    lineAdjustments: [],
    total: 0,
    stacksWithPromotions: true,
  };
}

interface GroupPricingRow {
  id: number;
  scopeCategoryId: number | null;
  scopeProductId: number | null;
  scopeVariantId: number | null;
  discountType: string;
  discountValue: number;
  minPurchaseAmount: number;
  minQuantity: number | null;
  maxDiscountAmount: number | null;
  stacksWithPromotions: boolean;
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
 * Evaluate the group-pricing layer for a cart. `items` must be the SAME
 * array (same order) that is then passed to the cart engine, so the
 * returned lineAdjustments stay index-aligned.
 */
export async function evaluateSaleGroupPricing(
  dbe: Pick<typeof db, "select">,
  businessId: number,
  customerId: number | null,
  items: EvalItem[],
): Promise<SaleGroupPricing> {
  if (customerId == null || items.length === 0) return NONE;

  const [customer] = await dbe
    .select({ id: customers.id, groupId: customers.customerGroupId })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.businessId, businessId)))
    .limit(1);
  if (!customer?.groupId) return NONE;

  const [group] = await dbe
    .select({ id: customerGroups.id, name: customerGroups.name, isActive: customerGroups.isActive })
    .from(customerGroups)
    .where(and(eq(customerGroups.id, customer.groupId), eq(customerGroups.businessId, businessId)))
    .limit(1);
  if (!group || !group.isActive) return NONE;

  const rows = (await dbe
    .select()
    .from(customerGroupPricing)
    .where(
      and(
        eq(customerGroupPricing.businessId, businessId),
        eq(customerGroupPricing.groupId, group.id),
        eq(customerGroupPricing.isActive, true),
      ),
    )) as unknown as (typeof customerGroupPricing.$inferSelect)[];
  if (rows.length === 0) {
    // Keep the group identity: promotion group-restrictions are evaluated
    // against it even when this group grants no pricing.
    return membershipWithoutPricing(group.id, group.name);
  }

  // Server-side date validation against the business-local calendar date.
  const [bizRow] = await dbe
    .select({ timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const today = businessLocalDate(new Date(), bizRow?.timezone ?? "Asia/Dhaka");

  const itemsTotal = roundMoney(items.reduce((sum, item) => sum + lineTotalOf(item), 0));
  const itemsQuantity = items.reduce((sum, item) => sum + item.quantity, 0);

  const eligible = rows
    .map((row) => ({
      id: row.id,
      scopeCategoryId: row.categoryId,
      scopeProductId: row.productId,
      scopeVariantId: row.variantId,
      discountType: row.discountType,
      discountValue: Number(row.discountValue),
      minPurchaseAmount: Number(row.minPurchaseAmount),
      minQuantity: row.minQuantity,
      maxDiscountAmount:
        row.maxDiscountAmount == null ? null : Number(row.maxDiscountAmount),
      validFrom: row.validFrom,
      validTo: row.validTo,
      stacksWithPromotions: row.stacksWithPromotions,
    }))
    .filter((row) => {
      if (row.minPurchaseAmount > itemsTotal) return false;
      if (row.minQuantity != null && row.minQuantity > itemsQuantity) return false;
      // Server-side validity window (business-local calendar date).
      if (row.validFrom && row.validFrom > today) return false;
      if (row.validTo && row.validTo < today) return false;
      return true;
    });
  if (eligible.length === 0) {
    // Rows exist but none apply to this cart — the membership identity is
    // still real (promotion group-restrictions evaluate against it).
    return membershipWithoutPricing(group.id, group.name);
  }

  // Variant → product/category map for scoped matching (one query).
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

  const cartAmounts: CartGroupAmount[] = [];
  const lineAdjustments: (CartGroupAmount | null)[] = items.map(() => null);
  let total = 0;
  // Phase 5 consent: every APPLIED row must allow promotions to stack.
  let appliedRowsAllowPromotions = true;

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

  for (const row of eligible) {
    const isWholeCart =
      row.scopeCategoryId == null &&
      row.scopeProductId == null &&
      row.scopeVariantId == null;

    if (isWholeCart) {
      const amount = computeAmount(row, itemsTotal);
      if (amount > 0) {
        cartAmounts.push({ refId: row.id, amount });
        total = roundMoney(total + amount);
        appliedRowsAllowPromotions =
          appliedRowsAllowPromotions && row.stacksWithPromotions;
      }
      continue;
    }

    // Scoped rows: apply to the matching lines, cap the row's AGGREGATE at
    // maxDiscountAmount via proportional scaling (last matching line absorbs
    // the remainder).
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
      amount: computeAmount(row, lineTotalOf(items[idx]!)),
    }));
    const rawTotal = roundMoney(raw.reduce((sum, r) => sum + r.amount, 0));
    const cap = row.maxDiscountAmount;
    let scaled = raw;
    if (cap != null && rawTotal > roundMoney(cap)) {
      const scale = cap / rawTotal;
      scaled = raw.map((r) => ({ idx: r.idx, amount: roundMoney(r.amount * scale) }));
      // Last line absorbs the rounding remainder against the cap.
      const scaledTotal = roundMoney(scaled.reduce((s, r) => s + r.amount, 0));
      const last = scaled[scaled.length - 1]!;
      last.amount = roundMoney(last.amount + (roundMoney(cap) - scaledTotal));
    }
    for (const r of scaled) {
      if (r.amount <= 0) continue;
      const existing = lineAdjustments[r.idx];
      lineAdjustments[r.idx] = {
        refId: row.id,
        amount: roundMoney((existing?.amount ?? 0) + r.amount),
      };
      total = roundMoney(total + r.amount);
      appliedRowsAllowPromotions =
        appliedRowsAllowPromotions && row.stacksWithPromotions;
    }
  }

  // The group layer can never exceed the cart itself.
  if (total > itemsTotal) {
    const scale = itemsTotal / total;
    for (const a of cartAmounts) a.amount = roundMoney(a.amount * scale);
    for (let i = 0; i < lineAdjustments.length; i++) {
      const a = lineAdjustments[i];
      if (a) lineAdjustments[i] = { ...a, amount: roundMoney(a.amount * scale) };
    }
    total = itemsTotal;
  }

  return {
    groupId: group.id,
    groupName: group.name,
    cartAmounts,
    lineAdjustments,
    total,
    stacksWithPromotions: appliedRowsAllowPromotions,
  };
}

/** Engine input shaped from an evaluation (keeps the call sites terse). */
export function toCartGroupInput(evaluation: SaleGroupPricing): CartGroupInput {
  if (evaluation.groupId == null) return EMPTY_GROUP_INPUT;
  return {
    cartAmounts: evaluation.cartAmounts,
    lineAdjustments: evaluation.lineAdjustments,
  };
}
