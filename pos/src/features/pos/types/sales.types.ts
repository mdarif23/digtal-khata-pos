import type { SaleReceiptData } from "./receipt.types.js";
import type { CreateSalePayload } from "../schemas/cart.schema.js";
export interface SalesStoreType {
  id: number;
  saleItemsId: number;
  saleId: number;
  productName: string;
  /** Variant identity from the API — null-safe for older payloads. */
  variantId?: number | undefined;
  sku?: string | null;
  barcode?: string | null;
  /** Comma-joined option values, e.g. "Small". */
  variantOptions?: string | undefined;
  /** Full display label, e.g. "Football (Small)". */
  variantName?: string | undefined;
  soldQuantity: number;
  cost: number;
  price: number;
  category: string | null;
  createdAt: string | null;
  soldPrice: number;
  lineTotal: number;
  invoiceNumber: string;
  saleTotal: number | null;
  paymentStatus: "paid" | "partial" | "unpaid";
  saleStatus: "completed" | "held" | "cancelled" | "refunded";
  customerName: string | null;
  returnedQuantity: number;
  returnReason: string | null;
  returnDisposition: "restock" | "inspection" | "damaged" | null;
  /** Serial-tracked lines cannot be partially returned without selecting
   *  serials — the return dialog keeps them whole. */
  trackingType?: "none" | "batch" | "serial" | null;
}
export interface SaleRefundRequest {
  reason:
    | "customer_request"
    | "wrong_item"
    | "damaged"
    | "quality_issue"
    | "other";
  notes?: string;
  disposition: "restock" | "inspection" | "damaged";
  /** Per-line partial returns: how many units of each sale item come back.
   *  Omitted = the full remaining quantity of every listed line (legacy
   *  whole-sale behavior). Serial-tracked lines can't be partially returned
   *  without a serial selection, so the UI keeps those lines whole. */
  quantities?: { saleItemId: number; quantity: number }[];
  refundMethod?: "cash" | "store_credit" | "original_payment";
}
export type CreateSaleResponse = {
  success: boolean;
  message: string;
  data: {
    sale: {
      id: number;
      invoiceNumber: string;
      subtotal: number | null;
      discount: number | null;
      vat: number | null;
      finalTotal: number | null;
      dueAmount: number | null;
      paymentStatus: "paid" | "partial" | "unpaid";
    };
    change: number;
    paidAmount: number;
    dueAmount: number;
    receipt?: SaleReceiptData;
  };
};
export interface SalesStore {
  sales: SalesStoreType[];
  loading: boolean;
  error: null | string;
  getSales: () => Promise<void>;
  createSale: (data: CreateSalePayload) => Promise<CreateSaleResponse>;
  returnSingleItems: (
    item: SalesStoreType,
    options: SaleRefundRequest,
  ) => Promise<void>;
  returnProducts: (id: number, options: SaleRefundRequest) => Promise<void>;
}
export interface AllSoldProduct {
  id: number;
  invoiceNumber: string;
  items: SalesStoreType[];
  createdAt: string | null;
  totalQuantity: number;
  totalAmount: number;
  paymentStatus: "paid" | "partial" | "unpaid";
  saleStatus: "completed" | "held" | "cancelled" | "refunded";
  customerName: string | null;
}
