export type PaperWidth = "58mm" | "80mm" | "a4";

export interface SaleReceiptCustomer {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
}

export interface SaleReceiptTaxDetail {
  taxRateId: number;
  name: string;
  rate: number;
  isInclusive: boolean;
  amount: number;
}

/**
 * Per-line warranty snapshot (backend getSaleReceipt enrichment): present
 * when the sold line carries an issued warranty. Additive — older receipts
 * omit it.
 */
export interface SaleReceiptItemWarranty {
  warrantyNumber: string;
  provider: string;
  warrantyType: string;
  duration: number;
  durationUnit: string;
  startDate: string | Date;
  validUntil: string | Date;
}

export interface SaleReceiptItem {
  id: number;
  variantId: number;
  productName: string;
  variantName: string | null;
  sku: string | null;
  barcode: string | null;
  /** Unit abbreviation of the product (e.g. "Pcs"), when the product has one. */
  unitName?: string | null;
  /** Base-unit quantity (packages already converted by the server). */
  quantity: number;
  /** Base-unit price. */
  unitPrice: number;
  discount: number;
  lineTotal: number;
  // Packaging-unit selling: what the cashier ENTERED, when the line was
  // sold in a package unit (e.g. 1 Box @ 120 = 12 pcs @ 10). Null/absent
  // for base-unit lines.
  enteredQuantity?: number | null;
  enteredUnitPrice?: number | null;
  conversionFactor?: number | null;
  enteredUnitAbbreviation?: string | null;
  /** Historical tax snapshot (Module 4): tax content of this line. */
  taxAmount: number;
  taxDetail: SaleReceiptTaxDetail[];
  /**
   * Discount attribution snapshots (Phases 4-6): group pricing, promotions
   * and price overrides in application order — rendered as a per-line
   * breakdown when present.
   */
  priceAdjustments?: {
    kind: "group" | "promotion" | "manual" | "coupon";
    refId: number | null;
    name: string | null;
    amount: number;
    reason?: string | null;
  }[];
  /**
   * Warranty enrichment (migration 0064): the serial texts of the sold
   * units and this line's issued-warranty snapshot, rendered as per-line
   * sub-lines on receipts/invoices when present.
   */
  serialNumbers?: string[];
  warranty?: SaleReceiptItemWarranty;
}

export interface SaleReceiptPayment {
  id?: number;
  method: string;
  amount: number;
  tendered: number | null;
  reference: string | null;
  paymentDate: string | Date;
}

/** Business branding embedded by the backend on every receipt payload. */
export interface SaleReceiptBusiness {
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  website: string | null;
  vatBin: string | null;
  tagline: string | null;
  logoUrl: string | null;
  currency: string;
}

export interface SaleReceiptData {
  saleId: number;
  invoiceNumber: string;
  saleDate: string | Date;
  createdAt: string | Date | null;
  /** Name of the user who rang up the sale (when recorded). */
  cashierName?: string | null;
  customer: SaleReceiptCustomer | null;
  business?: SaleReceiptBusiness;
  /** Saved document templates; validated client-side before use. */
  documentSettings?: {
    sales_receipt?: unknown;
    sales_invoice?: unknown;
    defaultsVersion?: number;
  };
  items: SaleReceiptItem[];
  subtotal: number;
  discount: number;
  vat: number;
  finalTotal: number;
  dueAmount: number;
  paidAmount: number;
  change: number;
  paymentStatus: "paid" | "partial" | "unpaid";
  note?: string | null;
  payments: SaleReceiptPayment[];
}

export interface ReceiptSettings {
  shopName: string;
  tagline: string;
  phone: string;
  address: string;
  logoUrl?: string | null;
  paperWidth: PaperWidth;
  autoPrintOnSale: boolean;
  showCustomerInfo: boolean;
  headerMessage: string;
  footerMessage: string;
  returnPolicy: string;
  cashierName: string;
}

