import { and, eq } from "drizzle-orm";
import { ZodError } from "zod";
import { db } from "../../db/schema/index.js";
import { businesses } from "../../db/schema/businesses.js";
import { documentSettings as documentSettingsTable } from "../../db/schema/documentSettings.js";
import { BadRequestError } from "../../utils/handleError.js";
import {
  TEMPLATE_VERSION,
  invoiceConfigSchema,
  isDocumentType,
  receiptConfigSchema,
  type DocumentType,
  type InvoiceConfig,
  type ReceiptConfig,
} from "./documentSettings.schemas.js";

/**
 * Parse a stored config against its schema, filling every missing field
 * from the versioned defaults and stripping unknown keys. A row that fails
 * validation entirely (hand-edited, corrupt) falls back to the pristine
 * defaults rather than breaking printing.
 */
function normalizeReceiptConfig(stored: unknown): ReceiptConfig {
  const parsed = receiptConfigSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : receiptConfigSchema.parse({});
}

function normalizeInvoiceConfig(stored: unknown): InvoiceConfig {
  const parsed = invoiceConfigSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : invoiceConfigSchema.parse({});
}

export interface DocumentSettingsBundle {
  sales_receipt: ReceiptConfig;
  sales_invoice: InvoiceConfig;
  defaultsVersion: number;
}

export async function getDocumentSettings(
  businessId: number,
): Promise<DocumentSettingsBundle> {
  const rows = await db
    .select({
      docType: documentSettingsTable.docType,
      config: documentSettingsTable.config,
    })
    .from(documentSettingsTable)
    .where(eq(documentSettingsTable.businessId, businessId));

  const byType = new Map(rows.map((r) => [r.docType, r.config]));
  return {
    sales_receipt: normalizeReceiptConfig(byType.get("sales_receipt")),
    sales_invoice: normalizeInvoiceConfig(byType.get("sales_invoice")),
    defaultsVersion: TEMPLATE_VERSION,
  };
}

export async function saveDocumentSettings(
  businessId: number,
  docType: DocumentType,
  config: unknown,
): Promise<DocumentSettingsBundle> {
  // Validate FIRST so an invalid config never reaches the database — the
  // stored value must always parse back to a complete template. Zod errors
  // surface as client 400s, not 500s.
  const schema =
    docType === "sales_receipt" ? receiptConfigSchema : invoiceConfigSchema;
  const parsed = schema.safeParse(config ?? {});
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid ${docType} configuration: ${parsed.error.issues[0]?.message ?? "unknown field"}`,
    );
  }
  const validated = parsed.data;

  await db
    .insert(documentSettingsTable)
    .values({
      businessId,
      docType,
      config: validated as Record<string, unknown>,
      templateVersion: TEMPLATE_VERSION,
    })
    .onConflictDoUpdate({
      target: [documentSettingsTable.businessId, documentSettingsTable.docType],
      set: {
        config: validated as Record<string, unknown>,
        templateVersion: TEMPLATE_VERSION,
        updatedAt: new Date(),
      },
    });

  return getDocumentSettings(businessId);
}

/** Branding fields rendered on receipts and invoices, from `businesses`. */
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

/**
 * Business branding for documents. Read through the SAME business scoping
 * the caller already passed (`businessId` comes from resolved membership
 * context in every call path), so one business can never read another's
 * branding.
 */
export async function getDocumentBranding(
  businessId: number,
): Promise<DocumentBranding> {
  const [row] = await db
    .select({
      name: businesses.name,
      phone: businesses.phone,
      email: businesses.email,
      address: businesses.address,
      website: businesses.website,
      vatBin: businesses.vatBin,
      tagline: businesses.tagline,
      logoUrl: businesses.logoUrl,
      currency: businesses.currency,
    })
    .from(businesses)
    .where(and(eq(businesses.id, businessId)))
    .limit(1);

  return (
    row ?? {
      name: "",
      phone: null,
      email: null,
      address: null,
      website: null,
      vatBin: null,
      tagline: null,
      logoUrl: null,
      currency: "BDT",
    }
  );
}

export { isDocumentType };
