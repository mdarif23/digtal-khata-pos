// cartPricing.ts
export type DiscountKind = "percentage" | "fixed";
export type DiscountInput =
  | { type: DiscountKind; value: number }
  | null
  | undefined;

type PricedItem = {
  quantity: number | string;
  discount?: DiscountInput;
  variants: { sellingPrice: number | string }[];
  /** Price per SELECTED unit (packaging-unit lines); falls back to the variant price. */
  unitPrice?: number | string;
};

export const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Discount amount for a given base. Never below 0, never above the base.
export function calcDiscountAmount(base: number, discount: DiscountInput): number {
  if (!discount || base <= 0) return 0;
  const value = Number(discount.value) || 0;
  const raw =
    discount.type === "percentage"
      ? (base * Math.min(value, 100)) / 100
      : value;
  return money(Math.min(Math.max(raw, 0), base));
}

// One cart line: price x quantity, minus the line discount
export function getLinePricing(
  unitPrice: number | string,
  quantity: number | string,
  discount: DiscountInput,
) {
  const base = money(Number(unitPrice) * Number(quantity));
  const discountAmount = calcDiscountAmount(base, discount);
  return { base, discountAmount, total: money(base - discountAmount) };
}

// Order: item discounts -> cart discount -> VAT on the discounted amount
export function getCartTotals(
  cart: PricedItem[],
  cartDiscount: DiscountInput,
  vatPercent: number,
) {
  let itemsBase = 0;
  let itemDiscount = 0;

  for (const item of cart) {
    const price = item.unitPrice ?? item.variants[0]?.sellingPrice;
    if (price == null) continue;
    const line = getLinePricing(price, item.quantity, item.discount);
    itemsBase += line.base;
    itemDiscount += line.discountAmount;
  }

  itemsBase = money(itemsBase);
  itemDiscount = money(itemDiscount);

  const itemsTotal = money(itemsBase - itemDiscount); // after item discounts
  const cartDiscountAmount = calcDiscountAmount(itemsTotal, cartDiscount);
  const afterDiscount = money(itemsTotal - cartDiscountAmount);

  const safeVatPercent = Math.min(Math.max(Number(vatPercent) || 0, 0), 100);
  const vat = money((afterDiscount * safeVatPercent) / 100);

  return {
    itemsBase,
    itemDiscount,
    itemsTotal,
    cartDiscountAmount,
    afterDiscount,
    vatPercent: safeVatPercent,
    vat,
    finalTotal: money(afterDiscount + vat),
  };
}