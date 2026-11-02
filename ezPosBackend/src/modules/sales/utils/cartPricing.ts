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

// Order: item discounts -> cart discount -> VAT on the discounted amount
export function getCartTotals(
  items: Items[],
  cartDiscount: DiscountInput,
  vatPercent: number,
) {
  let itemsBase = 0;
  let itemDiscount = 0;

  for (const item of items) {
    const price = item.unitPrice;
    if (price == null) continue;
    const line = getLinePricing(price, item.quantity, item.discount);
    itemsBase += line.base;
    itemDiscount += line.discountAmount;
  }

  itemsBase = roundMoney(itemsBase);
  itemDiscount = roundMoney(itemDiscount);

  const itemsTotal = roundMoney(itemsBase - itemDiscount); // after item discounts
  const cartDiscountAmount = calcDiscountAmount(itemsTotal, cartDiscount);
  const afterDiscount = roundMoney(itemsTotal - cartDiscountAmount);

  const safeVatPercent = Math.min(Math.max(Number(vatPercent) || 0, 0), 100);
  const vat = roundMoney((afterDiscount * safeVatPercent) / 100);

  return {
    itemsBase,
    itemDiscount,
    itemsTotal,
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
}

export interface TaxedTotals {
  itemsBase: number;
  itemDiscount: number;
  itemsTotal: number;
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
  const cartDiscountAmount = calcDiscountAmount(itemsTotal, cartDiscount);

  // Pro-rata cart-discount allocation by line total; the last line absorbs
  // the rounding remainder so allocations sum exactly to the cart discount.
  const cartTotal = roundMoney(
    lineTotals.reduce((sum, l) => sum + l.total, 0),
  );
  const allocated: number[] = lineTotals.map((l) =>
    cartTotal > 0
      ? roundMoney((l.total / cartTotal) * cartDiscountAmount)
      : 0,
  );
  if (lineTotals.length > 0) {
    const lastIdx = allocated.length - 1;
    const allocatedSum = roundMoney(allocated.reduce((a, b) => a + b, 0));
    allocated[lastIdx] = roundMoney(
      (allocated[lastIdx] ?? 0) + (cartDiscountAmount - allocatedSum),
    );
  }

  const perLine: LineTax[] = [];
  let exclusiveTaxTotal = 0;
  let inclusiveTaxTotal = 0;

  lineTotals.forEach(({ item, total }, idx) => {
    const base = roundMoney(Math.max(0, total - allocated[idx]!));
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
    });
  });

  exclusiveTaxTotal = roundMoney(exclusiveTaxTotal);
  inclusiveTaxTotal = roundMoney(inclusiveTaxTotal);
  const afterDiscount = roundMoney(itemsTotal - cartDiscountAmount);

  return {
    itemsBase,
    itemDiscount,
    itemsTotal,
    cartDiscountAmount,
    afterDiscount,
    exclusiveTaxTotal,
    inclusiveTaxTotal,
    vat: roundMoney(exclusiveTaxTotal + inclusiveTaxTotal),
    finalTotal: roundMoney(afterDiscount + exclusiveTaxTotal),
    perLine,
  };
}
