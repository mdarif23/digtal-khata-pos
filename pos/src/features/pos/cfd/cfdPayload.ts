import type { CfdPushPayload } from "./cfd.api.js";
import type { CartTotalsView } from "../components/pos/CartItems.js";

/**
 * Customer-facing display payload composition (P0 fix #4). The display must
 * show the SAME money the checkout will charge — so the totals come from the
 * shared useCartTotals view (server-quoted when available, local fallback
 * otherwise), never a second pricing engine.
 */

interface CfdCartLine {
  name: string;
  unitName?: string | null;
  quantity: number;
  unitPrice?: number | null;
  priceOverride?: { unitPrice: number } | null | undefined;
  discount?: { type: "percentage" | "fixed"; value: number } | null;
}

export function roundMoney(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/** Cart view: per-line totals + every discount layer aggregated once. */
export function buildCfdCartPayload(
  cart: CfdCartLine[],
  totals: CartTotalsView,
): CfdPushPayload {
  const items = cart.map((item) => {
    const unitPrice = Number(item.priceOverride?.unitPrice ?? item.unitPrice ?? 0);
    const gross = roundMoney(Number(item.quantity) * unitPrice);
    const lineDiscount =
      item.discount?.type === "percentage"
        ? roundMoney((gross * Math.min(item.discount.value, 100)) / 100)
        : item.discount?.type === "fixed"
          ? roundMoney(Math.min(item.discount.value, gross))
          : 0;
    return {
      name: item.name,
      variantName: (item.unitName ?? null) as string | null,
      quantity: Number(item.quantity),
      unitPrice,
      lineTotal: roundMoney(gross - lineDiscount),
    };
  });
  // Every discount layer the totals view carries: manual line discounts,
  // manual cart discount, automatic customer-group pricing, auto-applied
  // promotions and the coupon. (The quote response reports group/promotions
  // totals across their cart and per-line application levels.)
  const discountTotal = roundMoney(
    totals.itemDiscount +
      totals.cartDiscountAmount +
      (totals.group?.discountAmount ?? 0) +
      (totals.promotions?.total ?? 0) +
      (totals.coupon?.discountAmount ?? 0),
  );
  return {
    status: items.length === 0 ? "idle" : "cart",
    items,
    discountTotal,
    vatTotal: roundMoney(totals.vat),
    grandTotal: roundMoney(totals.finalTotal),
    paidTotal: 0,
    dueTotal: 0,
  };
}

interface CfdReceiptLine {
  productName: string;
  variantName?: string | null;
  quantity: number;
  unitPrice?: number | null;
  lineTotal?: number | null;
}

interface CfdReceiptTotals {
  discount?: number | null;
  vat?: number | null;
  finalTotal?: number | null;
  paidAmount?: number | null;
  dueAmount?: number | null;
}

/** Post-payment view: the receipt's own numbers, never the cart estimate. */
export function buildCfdPaidPayload(
  items: CfdReceiptLine[],
  receipt: CfdReceiptTotals,
): CfdPushPayload {
  return {
    status: "paid",
    items: items.map((item) => ({
      name: item.productName,
      variantName: item.variantName ?? null,
      quantity: Number(item.quantity),
      unitPrice: roundMoney(Number(item.unitPrice ?? 0)),
      lineTotal: roundMoney(Number(item.lineTotal ?? 0)),
    })),
    discountTotal: roundMoney(Number(receipt.discount ?? 0)),
    vatTotal: roundMoney(Number(receipt.vat ?? 0)),
    grandTotal: roundMoney(Number(receipt.finalTotal ?? 0)),
    paidTotal: roundMoney(Number(receipt.paidAmount ?? 0)),
    dueTotal: roundMoney(Number(receipt.dueAmount ?? 0)),
  };
}
