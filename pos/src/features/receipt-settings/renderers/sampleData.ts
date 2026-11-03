import type { SaleReceiptData } from "../../pos/types/receipt.types.js";
import type { DocumentBranding } from "../schemas/documentSettings.schema.js";

/**
 * Clearly-labeled sample transaction for the live preview and test print.
 * Purely client-side — the preview NEVER creates a sale or touches
 * financial records.
 */

export const SAMPLE_RECEIPT: SaleReceiptData = {
  saleId: 0,
  invoiceNumber: "INV-2026-SAMPLE",
  saleDate: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  cashierName: "Rahim (Sample)",
  customer: {
    id: 0,
    name: "Sample Customer",
    phone: "+880 1711-000000",
    address: "12/A Sample Road, Dhaka",
  },
  items: [
    {
      id: 0,
      variantId: 0,
      productName: "Fresh Milk 1L",
      variantName: null,
      sku: "MILK-1L",
      barcode: "885000000115",
      unitName: "Pcs",
      quantity: 2,
      unitPrice: 95,
      discount: 0,
      lineTotal: 190,
      taxAmount: 0,
      taxDetail: [],
    },
    {
      id: 0,
      variantId: 0,
      productName: "Premium Basmati Rice",
      variantName: "5 kg bag",
      sku: "RICE-5KG",
      barcode: null,
      unitName: "Bag",
      quantity: 1,
      unitPrice: 720,
      discount: 20,
      lineTotal: 700,
      taxAmount: 0,
      taxDetail: [],
    },
    {
      id: 0,
      variantId: 0,
      productName: "Cotton T-Shirt",
      variantName: "Black / L",
      sku: "TSH-BLK-L",
      barcode: "885000000927",
      unitName: "Pcs",
      quantity: 1,
      unitPrice: 550,
      discount: 50,
      lineTotal: 500,
      taxAmount: 0,
      taxDetail: [],
    },
  ],
  subtotal: 1390,
  discount: 70,
  vat: 0,
  finalTotal: 1320,
  dueAmount: 0,
  paidAmount: 1500,
  change: 180,
  paymentStatus: "paid",
  payments: [
    {
      id: 0,
      method: "cash",
      amount: 1000,
      tendered: 1000,
      reference: null,
      paymentDate: new Date().toISOString(),
    },
    {
      id: 0,
      method: "card",
      amount: 320,
      tendered: null,
      reference: "TXN-SAMPLE-001",
      paymentDate: new Date().toISOString(),
    },
  ],
};

export const SAMPLE_BRANDING: DocumentBranding = {
  name: "Sample Business Name",
  phone: "+880 1870-000000",
  email: "hello@samplebusiness.com",
  address: "House 12, Road 4, Sample Area, Dhaka 1205",
  website: "https://samplebusiness.com",
  vatBin: "BIN-0000000-0000",
  tagline: "Quality you can trust",
  logoUrl: null,
  currency: "BDT",
};
