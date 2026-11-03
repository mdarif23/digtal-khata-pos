import { z } from "zod";

/**
 * Frontend mirror of the backend document-settings contract
 * (ezPosBackend/src/modules/documentSettings/documentSettings.schemas.ts).
 * Kept in sync by hand — the two apps do not share code. Every field has a
 * default so a partially-known saved config renders completely; the backend
 * is the validation authority, this mirror shapes the settings forms and
 * gives the renderer typed configs.
 *
 * PRESENTATION ONLY — no financial values live in a template.
 */

const booleanFlag = z.boolean();

export const receiptVisibilitySchema = z.object({
  logo: booleanFlag.default(true),
  businessName: booleanFlag.default(true),
  businessAddress: booleanFlag.default(true),
  businessPhone: booleanFlag.default(true),
  businessEmail: booleanFlag.default(false),
  vatBin: booleanFlag.default(false),
  invoiceNumber: booleanFlag.default(true),
  dateTime: booleanFlag.default(true),
  cashierName: booleanFlag.default(true),
  customerName: booleanFlag.default(true),
  customerPhone: booleanFlag.default(false),
  productName: booleanFlag.default(true),
  sku: booleanFlag.default(false),
  barcode: booleanFlag.default(false),
  quantity: booleanFlag.default(true),
  unitPrice: booleanFlag.default(true),
  lineDiscount: booleanFlag.default(true),
  lineTotal: booleanFlag.default(true),
  subtotal: booleanFlag.default(true),
  overallDiscount: booleanFlag.default(true),
  vat: booleanFlag.default(true),
  grandTotal: booleanFlag.default(true),
  paymentMethod: booleanFlag.default(true),
  paidAmount: booleanFlag.default(true),
  dueAmount: booleanFlag.default(true),
  changeAmount: booleanFlag.default(true),
  qrCode: booleanFlag.default(false),
});

export const receiptLayoutSchema = z.object({
  fontSize: z.number().int().min(9).max(14).default(12),
  headerAlign: z.enum(["left", "center"]).default("center"),
  logoWidthPx: z.number().int().min(40).max(200).default(96),
  marginMm: z.number().min(0).max(8).default(3),
  headerSpacingPx: z.number().int().min(0).max(48).default(8),
  footerSpacingPx: z.number().int().min(0).max(48).default(12),
  itemTableStyle: z.enum(["compact", "detailed"]).default("detailed"),
  showSeparators: booleanFlag.default(true),
});

export const receiptTextSchema = z.object({
  title: z.string().trim().max(60).default("Sales Receipt"),
  footerMessage: z
    .string()
    .trim()
    .max(300)
    .default("Returns accepted within 7 days with this receipt."),
  thankYouMessage: z
    .string()
    .trim()
    .max(200)
    .default("Thank you for your business!"),
  additionalMessage: z.string().trim().max(300).default(""),
});

export const receiptPrintSchema = z.object({
  autoPrintOnSale: booleanFlag.default(false),
  copies: z.number().int().min(1).max(3).default(1),
});

export const receiptConfigSchema = z.object({
  paperWidth: z.enum(["58mm", "80mm"]).default("80mm"),
  visibility: receiptVisibilitySchema.prefault({}),
  layout: receiptLayoutSchema.prefault({}),
  text: receiptTextSchema.prefault({}),
  print: receiptPrintSchema.prefault({}),
});

export const invoiceVisibilitySchema = z.object({
  logo: booleanFlag.default(true),
  businessName: booleanFlag.default(true),
  businessAddress: booleanFlag.default(true),
  businessPhone: booleanFlag.default(true),
  businessEmail: booleanFlag.default(true),
  website: booleanFlag.default(true),
  vatBin: booleanFlag.default(true),
  invoiceNumber: booleanFlag.default(true),
  invoiceDate: booleanFlag.default(true),
  customerInfo: booleanFlag.default(true),
  customerAddress: booleanFlag.default(true),
  itemDescription: booleanFlag.default(true),
  itemSku: booleanFlag.default(true),
  itemUnit: booleanFlag.default(true),
  quantity: booleanFlag.default(true),
  unitPrice: booleanFlag.default(true),
  lineDiscount: booleanFlag.default(true),
  lineVat: booleanFlag.default(true),
  lineTotal: booleanFlag.default(true),
  subtotal: booleanFlag.default(true),
  overallDiscount: booleanFlag.default(true),
  vat: booleanFlag.default(true),
  grandTotal: booleanFlag.default(true),
  paidAmount: booleanFlag.default(true),
  dueAmount: booleanFlag.default(true),
  paymentInfo: booleanFlag.default(true),
  note: booleanFlag.default(true),
});

export const invoiceTextSchema = z.object({
  title: z.string().trim().max(60).default("INVOICE"),
  terms: z
    .string()
    .trim()
    .max(2000)
    .default(
      "Payment is due within 15 days. Goods remain the property of the seller until fully paid.",
    ),
  footerMessage: z.string().trim().max(300).default(""),
});

export const invoiceConfigSchema = z.object({
  paperSize: z.enum(["a4", "a5"]).default("a4"),
  visibility: invoiceVisibilitySchema.prefault({}),
  text: invoiceTextSchema.prefault({}),
  showSignature: booleanFlag.default(true),
});

export type ReceiptVisibility = z.infer<typeof receiptVisibilitySchema>;
export type ReceiptLayout = z.infer<typeof receiptLayoutSchema>;
export type ReceiptText = z.infer<typeof receiptTextSchema>;
export type ReceiptPrint = z.infer<typeof receiptPrintSchema>;
export type ReceiptConfig = z.infer<typeof receiptConfigSchema>;
export type InvoiceVisibility = z.infer<typeof invoiceVisibilitySchema>;
export type InvoiceText = z.infer<typeof invoiceTextSchema>;
export type InvoiceConfig = z.infer<typeof invoiceConfigSchema>;

export const DOCUMENT_TYPES = ["sales_receipt", "sales_invoice"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Parse an untrusted config (server/localStorage) into a complete one. */
export function normalizeReceiptConfig(stored: unknown): ReceiptConfig {
  const parsed = receiptConfigSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : receiptConfigSchema.parse({});
}

export function normalizeInvoiceConfig(stored: unknown): InvoiceConfig {
  const parsed = invoiceConfigSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : invoiceConfigSchema.parse({});
}

/** Business profile fields rendered on documents (source of truth: backend). */
export interface DocumentBranding {
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
