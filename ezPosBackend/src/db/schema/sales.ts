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
import { users } from "./users.js";
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
    /**
     * Duplicate-submission protection (offline replays included). Unique per
     * BUSINESS — see sales_idempotency_key_business_unique below; the old
     * plain column-level .unique() (a GLOBAL constraint) was migration 0015
     * and must not be regenerated.
     */
    idempotencyKey: varchar("idempotency_key", { length: 120 }),
    /**
     * SHA-256 of the canonical sale payload that first used the idempotency
     * key. A replay with the same key but different sale data is a client
     * bug (or tampering) and is rejected instead of silently returning the
     * original sale. NULL for legacy rows and keys without binding.
     */
    idempotencyPayloadHash: varchar("idempotency_payload_hash", {
      length: 64,
    }),
    /**
     * Terminal attribution (multi-terminal Phase 1). The registering PC that
     * rang the sale. Nullable: storefront/WooCommerce orders and legacy rows
     * have none. The composite (terminal_id, business_id) →
     * pos_terminals (id, business_id) FK is created in migration
     * 0049 — declared only there because posTerminals.ts already imports
     * this file (hardware_commands.sale_id), and the eager foreignKey()
     * helper cannot tolerate that import cycle.
     */
    terminalId: integer("terminal_id"),
    /**
     * Exchange transactions (Module 5): the replacement sale references the
     * original. Composite FK keeps the tenant guarantee; NULL for normal
     * sales. The original's refund rows + this sale's items tell the whole
     * exchange story.
     */
    exchangeOfSaleId: integer("exchange_of_sale_id"),
    /** Register attribution for staff performance (Module 15). */
    cashierUserId: integer("cashier_user_id").references(() => users.id),
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
    /** Storefront delivery charge, included in final_total (stage 5). */
    deliveryFee: numeric("delivery_fee", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).default(0),
    dueAmount: numeric("due_amount", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).default(0),
    /**
     * Order-time shipping snapshot (online orders). NULL for POS sales and
     * legacy online orders — the UI falls back to the customer record.
     * Editing the customer never rewrites these.
     */
    shippingName: varchar("shipping_name", { length: 150 }),
    shippingPhone: varchar("shipping_phone", { length: 30 }),
    shippingAddress: text("shipping_address"),
    shippingCity: varchar("shipping_city", { length: 100 }),
    shippingArea: varchar("shipping_area", { length: 100 }),
    deliveryInstructions: text("delivery_instructions"),
    /** Commission charged by external channels (online profitability input). */
    marketplaceCommission: numeric("marketplace_commission", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).default(0),
    note: text(),
    customerId: integer("customer_id").references(() => customers.id),
    /** Shopper account that placed a storefront order (nullable; guest = null). */
    shopperId: integer("shopper_id"),
  },
  (table) => [
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "sales_location_business_fkey",
    }),
    index("sales_business_location_idx").on(table.businessId, table.locationId),
    index("sales_business_id_idx").on(table.businessId),
    // Online order list + profitability scans filter by channel over a date
    // range within a business.
    index("sales_business_channel_date_idx").on(
      table.businessId,
      table.channel,
      table.saleDate,
    ),
    // Candidate key for composite FKs from sale_items / sale_payments /
    // sale_refunds / serial_numbers.
    unique("sales_id_business_uq").on(table.id, table.businessId),
    // Per-business idempotency — matches the live constraint created by
    // migration 0015. Keep this name and shape in sync; the plain column
    // .unique() this replaces would collide two tenants' client keys.
    unique("sales_idempotency_key_business_unique").on(
      table.businessId,
      table.idempotencyKey,
    ),
    // Terminal-scoped sale history (multi-terminal Phase 1).
    index("sales_business_terminal_idx").on(table.businessId, table.terminalId),
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
