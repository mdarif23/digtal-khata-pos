import axios from "../../api/axios.js";
import type { DiscountInput } from "./cartPricing.js";

/**
 * Server-authoritative cart totals. The backend resolves the same trusted
 * prices and tax rules that createSale will use, so the cashier always sees
 * exactly what the sale will charge — including product tax rules the
 * client cannot compute. Falls back to local math while loading/offline.
 */

export interface QuoteLineTax {
  variantId: number;
  taxAmount: number;
  detail: {
    taxRateId: number;
    name: string;
    rate: number;
    isInclusive: boolean;
    amount: number;
  }[];
}

export interface QuoteTotals {
  itemsBase: number;
  itemDiscount: number;
  itemsTotal: number;
  cartDiscountAmount: number;
  afterDiscount: number;
  vatPercent: number;
  vat: number;
  finalTotal: number;
  usesTaxRules: boolean;
  perLine: QuoteLineTax[];
  coupon?: { code: string; discountAmount: number; description: string | null };
  couponError?: string;
}

export async function quoteSaleApi(payload: {
  items: { variantId: number; quantity: number; discount: DiscountInput }[];
  cartDiscount: DiscountInput;
  vatPercent: number | null;
  couponCode?: string | null;
  customerId?: number | null;
}): Promise<QuoteTotals> {
  const res = await axios.post<{ data: QuoteTotals }>("/sales/quote", payload);
  return res.data.data;
}
