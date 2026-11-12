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
  /** Customer-group layer (Phase 4): automatic discount applied server-side. */
  group?: { id: number; name: string; discountAmount: number };
  /** Auto-applied promotions (Phase 5). */
  promotions?: { applied: { id: number; name: string; amount: number }[]; total: number };
  /** Phase 3 offer discovery: promotions the cart almost qualifies for. */
  nearMisses?: { id: number; name: string; reason: string }[];
  /** Minimum-price warnings (Phase 6): always informational on the quote. */
  warnings?: {
    variantId: number;
    code: "below_minimum";
    message: string;
    effectiveUnitPrice: number;
    minPrice: number | null;
    marginPercent: number | null;
    floorMarginPercent: number | null;
  }[];
}

export async function quoteSaleApi(payload: {
  items: {
    variantId: number;
    /** Quantity in the selected sell unit. */
    quantity: number;
    discount: DiscountInput;
    /** Packaging-unit selling: null/undefined = base unit. */
    uomConversionId?: number | null;
    /** Phase 6 preview: permitted override priced before checkout. */
    priceOverride?: { unitPrice: number; reason?: string } | null;
  }[];
  cartDiscount: DiscountInput;
  vatPercent: number | null;
  couponCode?: string | null;
  customerId?: number | null;
}): Promise<QuoteTotals> {
  const res = await axios.post<{ data: QuoteTotals }>("/sales/quote", payload);
  return res.data.data;
}
