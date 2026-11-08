import {
  foreignKey,
  index,
  pgTable,
  serial,
  integer,
  numeric,
  varchar,
  timestamp,
  pgEnum,
  text,
} from "drizzle-orm/pg-core";
import { purchases } from "./purchases.js";
import { businesses } from "./businesses.js";
import { paymentAccounts } from "./paymentAccounts.js";

// 1. Enum for Payment Method
export const paymentMethodEnum = pgEnum("payment_method", [
  "cash",
  "bank_transfer",
  "cheque",
  "card",
  "other",
]);

// 2. The Payments Table
export const purchasePayments = pgTable(
  "purchase_payments",
  {
    id: serial("id").primaryKey(),

    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),

    // Link back to the main purchase order
    purchaseId: integer("purchase_id").notNull(),

    // How much was paid in THIS specific transaction
    amount: numeric("amount", { precision: 12, scale: 2, mode: "number" }).notNull(),

    // The method used for THIS transaction
    method: paymentMethodEnum("method").notNull(),

    // Optional notes for this specific payment (e.g., "Cheque #12345")
    notes: text("notes"),

    paymentDate: timestamp("payment_date").defaultNow().notNull(),
    /**
     * Finance & Growth: cash/bank account this payment moved
     * (payment_accounts). Nullable — legacy rows predate Finance.
     */
    paymentAccountId: integer("payment_account_id"),
  },
  (table) => [
    index("purchase_payments_business_id_idx").on(table.businessId),
    foreignKey({
      columns: [table.purchaseId, table.businessId],
      foreignColumns: [purchases.id, purchases.businessId],
      name: "purchase_payments_purchase_business_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.paymentAccountId, table.businessId],
      foreignColumns: [paymentAccounts.id, paymentAccounts.businessId],
      name: "purchase_payments_payment_account_business_fkey",
    }),
  ],
);
