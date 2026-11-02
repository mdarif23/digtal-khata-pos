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
