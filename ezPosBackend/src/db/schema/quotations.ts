import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { customers } from "./customers.js";
import { users } from "./users.js";
import { productVariants } from "./productVariants.js";

/**
 * Quotations / estimates (Phase 2B — master prompt Feature 7). An OFFER
 * document with snapshot pricing: creating one never deducts stock, and
 * conversion re-runs backend-authoritative sale pricing on the quoted lines
 * inside one transaction (row-locked — double conversion impossible).
 */
export const quotationStatusEnum = pgEnum("quotation_status", [
  "draft",
  "sent",
  "accepted",
  "rejected",
  "expired",
  "converted",
  "cancelled",
]);

export const quotations = pgTable(
  "quotations",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    locationId: integer("location_id").notNull(),
    quoteNumber: varchar("quote_number", { length: 40 }).notNull(),
    customerId: integer("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    /** Walk-in quotes keep a display name (spec: walk-in supported). */
    customerNameSnapshot: varchar("customer_name_snapshot", { length: 255 }),
    status: quotationStatusEnum("status").notNull().default("draft"),
    subtotal: numeric("subtotal", { precision: 12, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    discountTotal: numeric("discount_total", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    vatTotal: numeric("vat_total", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    grandTotal: numeric("grand_total", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    vatPercent: numeric("vat_percent", {
      precision: 5,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    notes: text(),
    terms: text(),
    validUntil: date("valid_until"),
    convertedSaleId: integer("converted_sale_id"),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("quotations_business_number_uq").on(t.businessId, t.quoteNumber),
    unique("quotations_id_business_uq").on(t.id, t.businessId),
    index("quotations_business_status_idx").on(t.businessId, t.status),
    index("quotations_business_created_idx").on(t.businessId, t.createdAt),
  ],
);

export const quotationItems = pgTable(
  "quotation_items",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    quotationId: integer("quotation_id").notNull(),
    variantId: integer("variant_id").notNull(),
    variantNameSnapshot: varchar("variant_name_snapshot", { length: 255 }).notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 4, mode: "number" }).notNull(),
    unitPrice: numeric("unit_price", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    discount: numeric("discount", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    lineTotal: numeric("line_total", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
  },
  (t) => [
    index("quotation_items_quotation_idx").on(t.quotationId, t.id),
    foreignKey({
      columns: [t.quotationId, t.businessId],
      foreignColumns: [quotations.id, quotations.businessId],
      name: "quotation_items_quotation_business_fkey",
    }),
    foreignKey({
      columns: [t.variantId, t.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "quotation_items_variant_business_fkey",
    }),
    check(
      "quotation_items_values_check",
      sql`${t.quantity} > 0 AND ${t.unitPrice} >= 0 AND ${t.discount} >= 0 AND ${t.lineTotal} >= 0`,
    ),
  ],
);
