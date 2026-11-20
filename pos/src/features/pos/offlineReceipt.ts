import { getLinePricing, money } from "./cartPricing.js";
import type { CartTotalsView } from "./components/pos/CartItems.js";
import type { CreateSalePayload } from "./schemas/cart.schema.js";
import type { CartType } from "./types/cart.types.js";
import type {
  SaleReceiptData,
  SaleReceiptItem,
  SaleReceiptPayment,
} from "./types/receipt.types.js";

/**
 * Local receipt for an OFFLINE-recorded sale.
 *
 * The print pipeline (renderReceiptHtml + resolveBranding/resolveReceiptConfig)
 * was designed to work without the server: branding and template config fall
 * back to the local receipt-settings store when the receipt carries no
 * `business`/`documentSettings` — which is exactly the offline case. What the
 * offline sale genuinely lacks is the SERVER-assigned invoice number (and
 * server-issued warranty lines), so the slip is marked with a provisional
 * `OFF-` reference derived from the outbox id: traceable to the pending
 * outbox entry, unmistakably not an invoice.
 *
 * Totals come from the SAME CartTotalsView the cashier confirmed (the local
 * fallback math of useCartTotals — the server quote is unavailable offline),
 * so the slip matches what was taken at the counter.
 */

export const OFFLINE_INVOICE_PREFIX = "OFF-";

export function offlineInvoiceNumber(clientSaleId: string): string {
  return `${OFFLINE_INVOICE_PREFIX}${clientSaleId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export function buildOfflineReceipt(input: {
  cart: CartType[];
  totals: CartTotalsView;
  payments: CreateSalePayload["payments"];
  clientSaleId: string;
  customer: {
    id: number;
    name: string;
    phone: string | null;
    address: string | null;
  } | null;
  cashierName?: string | null;
}): SaleReceiptData {
  const items: SaleReceiptItem[] = input.cart.map((item, index) => {
    const unitPrice = item.unitPrice ?? Number(item.variants[0]?.sellingPrice ?? 0);
    const line = getLinePricing(unitPrice, item.quantity, item.discount ?? null);
    const isPackagingLine = item.uomConversionId != null;
    return {
      id: index + 1,
      variantId: item.variants[0]?.id ?? 0,
      productName: item.name,
      variantName:
        item.variants[0]?.options?.map((option) => option.value).join(" / ") ??
        null,
      sku: item.variants[0]?.sku ?? null,
      barcode: item.variants[0]?.barcode ?? null,
      quantity: item.quantity,
      unitName: item.unitName ?? null,
      unitPrice,
      discount: line.discountAmount,
      lineTotal: line.total,
      enteredQuantity: item.enteredQuantity ?? null,
      enteredUnitPrice: isPackagingLine ? unitPrice : null,
      conversionFactor: item.conversionFactor ?? null,
      enteredUnitAbbreviation: isPackagingLine
        ? item.unitAbbreviation ?? null
        : null,
      // Local fallback math has no per-line tax engine (flat VAT percent on
      // the whole sale) — the server receipt is the tax-authoritative one.
      taxAmount: 0,
      taxDetail: [],
      serialNumbers: item.serialNumbers ?? [],
    };
  });

  const payments: SaleReceiptPayment[] = input.payments.map((payment) => ({
    method: payment.method,
    amount: Number(payment.amount ?? 0),
    tendered: Number(payment.tendered ?? 0) || null,
    reference: null,
    paymentDate: new Date(),
  }));
  const paid = payments
    .filter((payment) => payment.method === "cash")
    .reduce((sum, payment) => sum + payment.amount, 0);
  const finalTotal = input.totals.finalTotal;
  const due = Math.max(money(finalTotal - paid), 0);

  return {
    // No server sale exists yet; the offline reference identifies the slip.
    saleId: 0,
    invoiceNumber: offlineInvoiceNumber(input.clientSaleId),
    saleDate: new Date(),
    createdAt: new Date(),
    cashierName: input.cashierName ?? null,
    customer: input.customer,
    items,
    subtotal: input.totals.itemsBase,
    // Offline the server discount layers (coupon, group pricing, promotions)
    // are unavailable — the local quote fallback never produced them.
    discount: money(
      input.totals.itemDiscount +
        input.totals.cartDiscountAmount +
        (input.totals.coupon?.discountAmount ?? 0),
    ),
    vat: input.totals.vat,
    charges: input.totals.charges.map((charge, index) => ({
      id: index + 1,
      label: charge.label,
      amount: charge.amount,
    })),
    chargesTotal: input.totals.chargesTotal,
    finalTotal,
    dueAmount: due,
    paidAmount: paid,
    change: 0,
    paymentStatus: due === 0 ? "paid" : paid > 0 ? "partial" : "unpaid",
    note: "Offline sale — invoice number assigned on sync",
    payments,
  };
}
