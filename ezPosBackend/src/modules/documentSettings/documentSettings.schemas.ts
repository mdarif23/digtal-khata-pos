import { z } from "zod";

/**
 * Document template configuration contracts.
 *
 * These schemas are the single source of truth for what a saved template may
 * contain. Every field has a default, so a stored config missing fields
 * (older template_version) parses into a complete current-shape config, and
 * unknown keys are stripped — forward/backward compatible without migrations.
 *
 * PRESENTATION ONLY: nothing here may carry financial values. Totals, tax,
 * paid/due always come from the sale transaction at render time.
 */

export const DOCUMENT_TYPES = ["sales_receipt", "sales_invoice"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export function isDocumentType(value: string): value is DocumentType {
  return (DOCUMENT_TYPES as readonly string[]).includes(value);
}

/** Current config contract version — bump when defaults/shape change. */
export const TEMPLATE_VERSION = 1;

const booleanFlag = z.boolean();

/**
 * Receipt visibility toggles. Defaults mirror the pre-customization receipt
 * (what the POS printed before this module existed) so nothing changes for
 * existing businesses until they edit the template.
 */
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
  /** Base body font size in px — thermal-legible range. */
  fontSize: z.number().int().min(9).max(14).default(12),
  /** Header block alignment; the item table always stays left-aligned. */
  headerAlign: z.enum(["left", "center"]).default("center"),
  /** Logo render width in px (capped to fit 58mm paper). */
  logoWidthPx: z.number().int().min(40).max(200).default(96),
  /** Page margin in mm (each side). */
  marginMm: z.number().min(0).max(8).default(3),
  /** Extra space under the header block, in px. */
  headerSpacingPx: z.number().int().min(0).max(48).default(8),
  /** Extra space above the footer block, in px. */
  footerSpacingPx: z.number().int().min(0).max(48).default(12),
  /** compact = one line per item; detailed = full column table. */
  itemTableStyle: z.enum(["compact", "detailed"]).default("detailed"),
  /** Horizontal separator lines between sections. */
  showSeparators: booleanFlag.default(true),
});

export const receiptTextSchema = z.object({
  /** Line printed above the item table (e.g. "Sales Receipt"). */
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
  /** Automatically open the print dialog after every completed sale. */
  autoPrintOnSale: booleanFlag.default(false),
  /** Receipt copies per print job (duplicated with page breaks, one dialog). */
  copies: z.number().int().min(1).max(3).default(1),
});

export const receiptConfigSchema = z.object({
  paperWidth: z.enum(["58mm", "80mm"]).default("80mm"),
  visibility: receiptVisibilitySchema.prefault({}),
  layout: receiptLayoutSchema.prefault({}),
  text: receiptTextSchema.prefault({}),
  print: receiptPrintSchema.prefault({}),
});

export type ReceiptVisibility = z.infer<typeof receiptVisibilitySchema>;
export type ReceiptLayout = z.infer<typeof receiptLayoutSchema>;
export type ReceiptText = z.infer<typeof receiptTextSchema>;
export type ReceiptPrint = z.infer<typeof receiptPrintSchema>;
export type ReceiptConfig = z.infer<typeof receiptConfigSchema>;

/**
 * Invoice visibility toggles. Defaults show everything a formal invoice
 * needs; businesses trim from there.
 */
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
    .default("Payment is due within 15 days. Goods remain the property of the seller until fully paid."),
  footerMessage: z.string().trim().max(300).default(""),
});

export const invoiceConfigSchema = z.object({
  paperSize: z.enum(["a4", "a5"]).default("a4"),
  visibility: invoiceVisibilitySchema.prefault({}),
  text: invoiceTextSchema.prefault({}),
  /** "Authorized signature" block above the footer. */
  showSignature: booleanFlag.default(true),
});

export type InvoiceVisibility = z.infer<typeof invoiceVisibilitySchema>;
export type InvoiceText = z.infer<typeof invoiceTextSchema>;
export type InvoiceConfig = z.infer<typeof invoiceConfigSchema>;

export const updateDocumentSettingsSchema = z.object({
  config: z.record(z.string(), z.unknown()),
});
export type UpdateDocumentSettingsInput = z.infer<
  typeof updateDocumentSettingsSchema
>;
