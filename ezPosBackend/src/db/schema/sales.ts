import {
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgSequence,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import {
  fulfillmentStatusEnum,
  saleChannelEnum,
} from "./commerceEnums.js";
import { integrations } from "./integrations.js";
import { sql } from "drizzle-orm";
import { customers } from "./customers.js";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";
export const paymentStatusEnum = pgEnum("payment_status", [
  "paid",
  "partial",
  "unpaid",
]);
export const saleStatusEnum = pgEnum("sale_status", [
  "pending",
  "completed",
  "held",
  "cancelled",
  "refunded",
]);
export const saleInvoiceNumberSeq = pgSequence("sale_invoice_number_seq", {
  startWith: 1,
  increment: 1,
});
export const sales = pgTable(
  "sales",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    status: saleStatusEnum("status").default("completed").notNull(),
    /** Sales channel (Phase 9): unified orders, distinguishable origin. */
    channel: saleChannelEnum("channel").default("pos").notNull(),
    integrationId: integer("integration_id").references(
      () => integrations.id,
      { onDelete: "set null" },
    ),
    externalOrderId: varchar("external_order_id", { length: 100 }),
    externalOrderNumber: varchar("external_order_number", { length: 100 }),
    /** Duplicate-submission protection for storefront orders. */
    idempotencyKey: varchar("idempotency_key", { length: 120 }).unique(),
    fulfillmentStatus: fulfillmentStatusEnum("fulfillment_status")
      .default("unfulfilled")
      .notNull(),
    // Owning outlet for this transaction. Nullable for legacy rows; the
    // application always sets it on new writes. Composite FK guarantees the
    // location belongs to the same business.
    locationId: integer("location_id"),
    invoiceNumber: varchar("invoice_number", { length: 50 })
      .notNull()
      .default(
        sql`'INV-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
        lpad(nextval('sale_invoice_number_seq')::text, 6, '0')`,
      ),
    saleDate: timestamp("purchase_date").defaultNow().notNull(),
    subtotal: numeric({ precision: 10, scale: 2, mode: "number" }),
    discount: numeric({ precision: 10, scale: 2, mode: "number" }).default(0),
    vat: numeric({ precision: 10, scale: 2, mode: "number" }).default(0),
    finalTotal: numeric("final_total", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    paymentStatus: paymentStatusEnum("payment_status").default("paid").notNull(),
    dueAmount: numeric("due_amount", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).default(0),
    note: text(),
    customerId: integer("customer_id").references(() => customers.id),
  },
  (table) => [
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "sales_location_business_fkey",
    }),
    index("sales_business_location_idx").on(table.businessId, table.locationId),
    index("sales_business_id_idx").on(table.businessId),
    // Candidate key for composite FKs from sale_items / sale_payments /
    // sale_refunds / serial_numbers.
    unique("sales_id_business_uq").on(table.id, table.businessId),
    // Per-business invoice numbering — two businesses may both issue
    // INV-2026-000001. The application supplies numbers from
    // document_sequences; the global-sequence default remains until the
    // approved cleanup stage.
    unique("sales_business_invoice_unique").on(
      table.businessId,
      table.invoiceNumber,
    ),
  ],
);
