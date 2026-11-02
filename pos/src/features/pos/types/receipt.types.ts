export type PaperWidth = "58mm" | "80mm" | "a4";

export interface SaleReceiptCustomer {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
}

export interface SaleReceiptItem {
  id: number;
  variantId: number;
  productName: string;
  variantName: string | null;
  sku: string | null;
  barcode: string | null;
  quantity: number;
  unitPrice: number;
  discount: number;
  lineTotal: number;
}

export interface SaleReceiptPayment {
  id?: number;
  method: string;
  amount: number;
  tendered: number | null;
  reference: string | null;
  paymentDate: string | Date;
}

export interface SaleReceiptData {
  saleId: number;
  invoiceNumber: string;
  saleDate: string | Date;
  createdAt: string | Date | null;
  customer: SaleReceiptCustomer | null;
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

