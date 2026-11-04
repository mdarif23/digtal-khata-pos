import {
  pgTable,
  foreignKey,
  index,
  serial,
  integer,
  text,
  timestamp,
  varchar,
  numeric,
  date,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { expenseCategories } from "./expenseCategories.js";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";
import { sales } from "./sales.js";
import { users } from "./users.js";
import { saleChannelEnum } from "./commerceEnums.js";

export const expenses = pgTable(
  "expenses",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    title: varchar({ length: 255 }).notNull(),
    amount: numeric({ precision: 10, scale: 2, mode: "number" }).notNull(),
    categoryId: integer("category_id"),
    /** Optional vendor/person the expense was paid to (Phase 4 payees). */
    payee: varchar({ length: 150 }),
    paymentMethod: varchar("payment_method", { length: 50 }),
    // Owning outlet for this transaction. Nullable for legacy rows; the
    // application always sets it on new writes. Composite FK guarantees the
    // location belongs to the same business.
    locationId: integer("location_id"),
    referenceNo: varchar("reference_no", { length: 100 }),
    /**
     * Optional channel attribution (online profitability): NULL = shared
     * across all channels; otherwise the expense is attributable to that
     * sales channel only.
     */
    channel: saleChannelEnum("channel"),
    /** Optional order link for order-specific expenses (estimated op. profit). */
    saleId: integer("sale_id"),
    note: text(),
    expenseDate: date("expense_date").notNull(),
    /**
     * Settlement ledger mirror, maintained ONLY inside the create/update/
     * payment service transactions. Authoritative source = expense_payments
     * rows; never computed from client input.
     */
    paidAmount: numeric("paid_amount", { precision: 10, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    /** Derived from paidAmount vs amount: 'unpaid' | 'partial' | 'paid'. */
    paymentStatus: varchar("payment_status", { length: 10 })
      .notNull()
      .default("unpaid"),
    createdBy: integer("created_by"),
    updatedBy: integer("updated_by"),
    /**
     * Soft void — financial records are never hard-deleted so historical
     * reports stay reproducible. Voided rows are excluded from every
     * financial view (list, reports, dashboard, profitability).
     */
    deletedAt: timestamp("deleted_at", { mode: "string" }),
    deletedBy: integer("deleted_by"),
    voidReason: text("void_reason"),
    createdAt: timestamp("created_at", { mode: "string" }).default(
      sql`CURRENT_TIMESTAMP`,
    ),
    updatedAt: timestamp("updated_at", { mode: "string" }).default(
      sql`CURRENT_TIMESTAMP`,
    ),
  },
  (table) => [
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "expenses_location_business_fkey",
    }),
    index("expenses_business_location_idx").on(table.businessId, table.locationId),
    index("expenses_business_id_idx").on(table.businessId),
    index("expenses_business_date_idx").on(table.businessId, table.expenseDate),
    index("expenses_business_status_idx").on(table.businessId, table.paymentStatus),
    index("expenses_business_category_idx").on(table.businessId, table.categoryId),
    foreignKey({
      columns: [table.categoryId, table.businessId],
      foreignColumns: [expenseCategories.id, expenseCategories.businessId],
      name: "expenses_category_business_fkey",
    }),
    foreignKey({
      columns: [table.saleId, table.businessId],
      foreignColumns: [sales.id, sales.businessId],
      name: "expenses_sale_business_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: "expenses_created_by_users_fk",
    }),
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [users.id],
      name: "expenses_updated_by_users_fk",
    }),
    foreignKey({
      columns: [table.deletedBy],
      foreignColumns: [users.id],
      name: "expenses_deleted_by_users_fk",
    }),
    // Business-scoped identity (migration 0039) — parent key for the
    // expense_payments composite FK.
    uniqueIndex("expenses_id_business_uq").on(table.id, table.businessId),
    check("expenses_amount_check", sql`amount >= (0)::numeric`),
    check(
      "expenses_payment_method_check",
      sql`(payment_method)::text = ANY ((ARRAY['Cash'::character varying, 'Mobile'::character varying, 'Card'::character varying])::text[])`,
    ),
    check(
      "expenses_payment_status_check",
      sql`payment_status::text = ANY ((ARRAY['unpaid'::character varying, 'partial'::character varying, 'paid'::character varying])::text[])`,
    ),
  ],
);
