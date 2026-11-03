import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";

/**
 * Document types that support per-business template customization. Sales
 * receipt and sales invoice ship first; future document kinds (sales return
 * slip, payment receipt) become new enum values with their own config schema
 * — never a reuse of the receipt config.
 */
export const documentTypeEnum = pgEnum("document_type", [
  "sales_receipt",
  "sales_invoice",
]);

/**
 * Per-business document template settings — one singleton row per
 * (business, document type). `config` holds ONLY presentation data
 * (visibility toggles, typography, custom text, printing preferences);
 * the business profile itself stays the source of truth on `businesses`.
 * Config shape is validated by the Zod schemas in
 * src/modules/documentSettings/documentSettings.schemas.ts and merged over
 * versioned defaults at read time, so older saved configs keep rendering
 * when new fields ship.
 */
export const documentSettings = pgTable(
  "document_settings",
  {
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    docType: documentTypeEnum("doc_type").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    /** Version of the default-template contract this config was written against. */
    templateVersion: integer("template_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.businessId, table.docType] })],
);
