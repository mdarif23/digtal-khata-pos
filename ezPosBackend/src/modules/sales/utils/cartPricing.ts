import { roundMoney } from "../../../utils/roundMoney.js";
import type { Items } from "../sales.validation.js";

// cartPricing.ts
export type DiscountKind = "percentage" | "fixed";
export type DiscountInput =
  | { type: DiscountKind; value: number }
  | null
// Discount amount for a given base. Never below 0, never above the base.
export function calcDiscountAmount(
  base: number,
  discount: DiscountInput,
): number {
  if (!discount || base <= 0) return 0;
  const value = Number(discount.value) || 0;
  const raw =
    discount.type === "percentage"
      ? (base * Math.min(value, 100)) / 100
      : value;
  return roundMoney(Math.min(Math.max(raw, 0), base));
}

// ---------------------------------------------------------------------------
// Customer-group pricing input (Phase 4). Amounts are computed server-side
// by evaluateSaleGroupPricing BEFORE the engine runs (master prompt stacking
// policy: base price → group discount → manual discounts → VAT), so the
// engine only receives final amounts and allocates them for tax + snapshots.
// Empty input = the pre-groups behavior, bit for bit.
// ---------------------------------------------------------------------------
export interface CartGroupAmount {
  /** customer_group_pricing row id (snapshot attribution). */
  refId: number | null;
  amount: number;
}
export interface CartGroupInput {
  /** Whole-cart group discounts, pro-rata allocated like the cart discount. */
  cartAmounts: CartGroupAmount[];
  /** Line-scoped group discounts, INDEX-ALIGNED with the items array. */
  lineAdjustments: (CartGroupAmount | null)[];
}
export const EMPTY_GROUP_INPUT: CartGroupInput = {
  cartAmounts: [],
  lineAdjustments: [],
};

/** Pro-rata allocation by line total; the last line absorbs the remainder. */
function allocateProRata(lineTotals: number[], amount: number): number[] {
  const cartTotal = roundMoney(lineTotals.reduce((sum, l) => sum + l, 0));
  const allocated = lineTotals.map((l) =>
    cartTotal > 0 ? roundMoney((l / cartTotal) * amount) : 0,
  );
  if (lineTotals.length > 0) {
    const lastIdx = allocated.length - 1;
    const allocatedSum = roundMoney(allocated.reduce((a, b) => a + b, 0));
    allocated[lastIdx] = roundMoney(
      (allocated[lastIdx] ?? 0) + (amount - allocatedSum),
    );
  }
  return allocated;
}

function groupCartTotalOf(group: CartGroupInput, itemsTotal: number): number {
  const raw = group.cartAmounts.reduce((sum, a) => sum + a.amount, 0);
  return roundMoney(Math.min(Math.max(raw, 0), itemsTotal));
}

// One cart line: price x quantity, minus the line discount
export function getLinePricing(
  unitPrice: number | string,
  quantity: number | string,
  discount: DiscountInput,
) {
  const base = roundMoney(Number(unitPrice) * Number(quantity));
  const discountAmount = calcDiscountAmount(base, discount);
  return { base, discountAmount, total: roundMoney(base - discountAmount) };
}

// Order: item discounts -> group discounts (whole-cart + line-scoped) ->
// cart discount (its percentage base is the post-group total) -> VAT.
export function getCartTotals(
  items: Items[],
  cartDiscount: DiscountInput,
  vatPercent: number,
  group: CartGroupInput = EMPTY_GROUP_INPUT,
) {
  let itemsBase = 0;
  let itemDiscount = 0;
  const lineTotalsList: number[] = [];

  for (const item of items) {
    const price = item.unitPrice;
    if (price == null) continue;
    const line = getLinePricing(price, item.quantity, item.discount);
    itemsBase += line.base;
    itemDiscount += line.discountAmount;
    lineTotalsList.push(line.total);
  }

  itemsBase = roundMoney(itemsBase);
  itemDiscount = roundMoney(itemDiscount);

  const itemsTotal = roundMoney(itemsBase - itemDiscount); // after item discounts
  const groupCartAmount = groupCartTotalOf(group, itemsTotal);

  // Per-line snapshot: each whole-cart row allocated pro-rata by line total,
  // plus the line-scoped amounts verbatim. Index-aligned with items.
  const groupLineAdjustments: CartGroupAmount[][] = items.map(() => []);
  lineTotalsList.forEach((_, idx) => {
    for (const cartRow of group.cartAmounts) {
      const alloc = allocateProRata(lineTotalsList, roundMoney(cartRow.amount))[idx] ?? 0;
      if (alloc > 0) groupLineAdjustments[idx]!.push({ refId: cartRow.refId, amount: alloc });
    }
    const adj = group.lineAdjustments[idx];
    if (adj && adj.amount > 0) {
      groupLineAdjustments[idx]!.push({ refId: adj.refId, amount: roundMoney(adj.amount) });
    }
  });
  const lineGroupTotal = roundMoney(
    group.lineAdjustments.reduce((sum, a) => sum + (a ? roundMoney(a.amount) : 0), 0),
  );

  // Manual cart discount bases on the POST-group total (stacking policy).
  const manualBase = Math.max(0, roundMoney(itemsTotal - groupCartAmount));
  const cartDiscountAmount = calcDiscountAmount(manualBase, cartDiscount);
  const afterDiscount = roundMoney(
    Math.max(0, itemsTotal - groupCartAmount - cartDiscountAmount - lineGroupTotal),
  );

  const safeVatPercent = Math.min(Math.max(Number(vatPercent) || 0, 0), 100);
  const vat = roundMoney((afterDiscount * safeVatPercent) / 100);

  return {
    itemsBase,
    itemDiscount,
    itemsTotal,
    groupCartAmount,
    lineGroupTotal,
    groupLineAdjustments,
    cartDiscountAmount,
    afterDiscount,
    vatPercent: safeVatPercent,
    vat,
    finalTotal: roundMoney(afterDiscount + vat),
  };
}

// ---------------------------------------------------------------------------
// Rules-based tax engine (Module 4). When any line's product carries tax
// rules, VAT comes from them instead of the legacy cart-wide vatPercent.
// ---------------------------------------------------------------------------

export interface TaxRuleSnapshot {
  taxRateId: number;
  name: string;
  /** Percent, up to 3 decimals. */
  rate: number;
  isInclusive: boolean;
}

export interface LineTax {
  variantId: number;
  /** Total tax content of the line (added for exclusive, extracted for inclusive). */
  taxAmount: number;
  detail: (TaxRuleSnapshot & { amount: number })[];
  /** Group-discount attribution for this line (snapshot source). */
  groupAdjustments: CartGroupAmount[];
}

export interface TaxedTotals {
  itemsBase: number;
  itemDiscount: number;
  itemsTotal: number;
  /** Sum of whole-cart group discounts (post-item-discount base). */
  groupCartAmount: number;
  /** Sum of line-scoped group discounts. */
  lineGroupTotal: number;
  cartDiscountAmount: number;
  afterDiscount: number;
  /** Tax added on top of the price (exclusive rules). */
  exclusiveTaxTotal: number;
  /** Tax extracted from prices that already contain it (inclusive rules). */
  inclusiveTaxTotal: number;
  /** sales.vat: total tax content = exclusive + inclusive. */
  vat: number;
  /** Money actually collected: afterDiscount + exclusive tax. Inclusive tax
   * is already inside afterDiscount and must NOT be added again. */
  finalTotal: number;
  perLine: LineTax[];
}

/**
 * Rules-based totals. Semantics per line:
 * - line base = price × qty − line discount, then a pro-rata share of the
 *   cart-level discount (allocated by line total so the cart discount
   *   always sums exactly).
 * - Exclusive rules: each rule's tax = base × rate/100, summed and ADDED to
 *   the final total.
 * - Inclusive rules: the line amount already contains the combined tax;
 *   combined tax = amount − amount/(1 + Σrate/100), split across rules
 *   proportionally to their rates. finalTotal contribution is the line
 *   amount itself (unchanged).
 * Lines without rules are tax-exempt in this mode — the legacy cart-wide
 * vatPercent is not applied at all (mixed semantics would double-tax).
 */
export function getCartTotalsWithTaxRules(
  items: Items[],
  cartDiscount: DiscountInput,
  rulesByVariant: Map<number, TaxRuleSnapshot[]>,
  group: CartGroupInput = EMPTY_GROUP_INPUT,
): TaxedTotals {
  let itemsBase = 0;
  let itemDiscount = 0;
  const lineTotals: { item: Items; total: number }[] = [];

  for (const item of items) {
    const price = item.unitPrice;
    if (price == null) continue;
    const line = getLinePricing(price, item.quantity, item.discount);
    itemsBase += line.base;
    itemDiscount += line.discountAmount;
    lineTotals.push({ item, total: line.total });
  }

  itemsBase = roundMoney(itemsBase);
  itemDiscount = roundMoney(itemDiscount);
  const itemsTotal = roundMoney(itemsBase - itemDiscount);
  const groupCartAmount = groupCartTotalOf(group, itemsTotal);

  // Manual cart discount bases on the POST-group total (stacking policy).
  const manualBase = Math.max(0, roundMoney(itemsTotal - groupCartAmount));
  const cartDiscountAmount = calcDiscountAmount(manualBase, cartDiscount);

  // Pro-rata allocations by line total (each pool's last line absorbs its
  // rounding remainder so allocations sum exactly to the pool amount).
  const totalsList = lineTotals.map((l) => l.total);
  const manualAlloc = allocateProRata(totalsList, cartDiscountAmount);
  const groupRowAllocs = group.cartAmounts.map((row) => ({
    refId: row.refId,
    amounts: allocateProRata(totalsList, roundMoney(row.amount)),
  }));
  // Line-scoped group adjustments, index-aligned with items (every trusted
  // item has a validated price, so the arrays stay aligned).
  const lineGroupTotal = roundMoney(
    group.lineAdjustments.reduce((sum, a) => sum + (a ? roundMoney(a.amount) : 0), 0),
  );

  const perLine: LineTax[] = [];
  let exclusiveTaxTotal = 0;
  let inclusiveTaxTotal = 0;

  lineTotals.forEach(({ item, total }, idx) => {
    const groupAdjustments: CartGroupAmount[] = [];
    let groupLineAmount = 0;
    for (const row of groupRowAllocs) {
      const alloc = row.amounts[idx] ?? 0;
      if (alloc > 0) {
        groupAdjustments.push({ refId: row.refId, amount: alloc });
        groupLineAmount = roundMoney(groupLineAmount + alloc);
      }
    }
    const lineAdj = group.lineAdjustments[idx];
    if (lineAdj && lineAdj.amount > 0) {
      groupAdjustments.push({ refId: lineAdj.refId, amount: roundMoney(lineAdj.amount) });
      groupLineAmount = roundMoney(groupLineAmount + roundMoney(lineAdj.amount));
    }

    const base = roundMoney(
      Math.max(
        0,
        total - (manualAlloc[idx] ?? 0) - groupLineAmount,
      ),
    );
    const rules = rulesByVariant.get(item.variantId) ?? [];
    const detail: (TaxRuleSnapshot & { amount: number })[] = [];
    let lineTax = 0;

    if (rules.length > 0) {
      const exclusive = rules.filter((r) => !r.isInclusive);
      const inclusive = rules.filter((r) => r.isInclusive);

      for (const rule of exclusive) {
        const amount = roundMoney((base * rule.rate) / 100);
        detail.push({ ...rule, amount });
        lineTax += amount;
      }
      exclusiveTaxTotal += lineTax;

      if (inclusive.length > 0) {
        const combinedRate = inclusive.reduce((s, r) => s + r.rate, 0);
        const combinedTax = roundMoney(
          base - base / (1 + combinedRate / 100),
        );
        let inclusiveSum = 0;
        inclusive.forEach((rule, i) => {
          const amount =
            i === inclusive.length - 1
              ? roundMoney(combinedTax - inclusiveSum)
              : roundMoney(
                  combinedTax *
                    (combinedRate > 0 ? rule.rate / combinedRate : 0),
                );
          inclusiveSum = roundMoney(inclusiveSum + amount);
          detail.push({ ...rule, amount });
          lineTax += amount;
        });
        inclusiveTaxTotal += combinedTax;
      }
    }

    perLine.push({
      variantId: item.variantId,
      taxAmount: roundMoney(lineTax),
      detail,
      groupAdjustments,
    });
  });

  exclusiveTaxTotal = roundMoney(exclusiveTaxTotal);
  inclusiveTaxTotal = roundMoney(inclusiveTaxTotal);
  const afterDiscount = roundMoney(
    Math.max(
      0,
      itemsTotal - cartDiscountAmount - groupCartAmount - lineGroupTotal,
    ),
  );

  return {
    itemsBase,
    itemDiscount,
    itemsTotal,
    groupCartAmount,
    lineGroupTotal,
    cartDiscountAmount,
    afterDiscount,
    exclusiveTaxTotal,
    inclusiveTaxTotal,
    vat: roundMoney(exclusiveTaxTotal + inclusiveTaxTotal),
    finalTotal: roundMoney(afterDiscount + exclusiveTaxTotal),
    perLine,
  };
}
