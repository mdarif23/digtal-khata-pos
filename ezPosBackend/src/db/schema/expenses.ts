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
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { expenseCategories } from "./expenseCategories.js";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";
import { sales } from "./sales.js";
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
    check("expenses_amount_check", sql`amount >= (0)::numeric`),
    check(
      "expenses_payment_method_check",
      sql`(payment_method)::text = ANY ((ARRAY['Cash'::character varying, 'Mobile'::character varying, 'Card'::character varying])::text[])`,
    ),
  ],
);
