import {
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businesses } from "./businesses.js";
import { expenses } from "./expenses.js";
import { locations } from "./locations.js";
import { registerSessions } from "./registers.js";
import { users } from "./users.js";

/**
 * Settlement ledger for expenses. A payment is a settlement of a cost —
 * expense totals always come from expenses.amount; payment rows only feed
 * paid/outstanding balances and cash-flow views (Z-report cash expenses).
 */
export const expensePayments = pgTable(
  "expense_payments",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    expenseId: integer("expense_id").notNull(),
    amount: numeric({ precision: 10, scale: 2, mode: "number" }).notNull(),
    // Same method vocabulary as expenses ('Cash' | 'Mobile' | 'Card') —
    // distinct from sale_payments' lowercase ledger-internal set.
    paymentMethod: varchar("payment_method", { length: 50 }).notNull(),
    paymentDate: date("payment_date").notNull().default(sql`CURRENT_DATE`),
    referenceNo: varchar("reference_no", { length: 100 }),
    note: text(),
    recordedBy: integer("recorded_by"),
    /** Register session this cash movement belongs to (drawer accounting). */
    registerSessionId: integer("register_session_id"),
    /** Outlet whose cash moved; mirrors the expense's location on writes. */
    locationId: integer("location_id"),
    /** Client-generated idempotency key (retried submits never duplicate). */
    clientUuid: uuid("client_uuid"),
    createdAt: timestamp("created_at", { mode: "string" }).default(
      sql`CURRENT_TIMESTAMP`,
    ),
  },
  (table) => [
    foreignKey({
      columns: [table.expenseId, table.businessId],
      foreignColumns: [expenses.id, expenses.businessId],
      name: "expense_payments_expense_business_fkey",
    }),
    foreignKey({
      columns: [table.recordedBy],
      foreignColumns: [users.id],
      name: "expense_payments_recorded_by_users_fk",
    }),
    foreignKey({
      columns: [table.registerSessionId, table.businessId],
      foreignColumns: [registerSessions.id, registerSessions.businessId],
      name: "expense_payments_session_business_fkey",
    }),
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "expense_payments_location_business_fkey",
    }),
    index("expense_payments_expense_id_idx").on(table.expenseId),
    index("expense_payments_business_date_idx").on(
      table.businessId,
      table.paymentDate,
    ),
    index("expense_payments_session_idx").on(table.registerSessionId),
    // Duplicate-submission protection, mirroring sale_payments: within a
    // business, one settlement per (method, reference). NULLs never collide.
    unique("expense_payments_business_method_reference_unique").on(
      table.businessId,
      table.paymentMethod,
      table.referenceNo,
    ),
    unique("expense_payments_client_uuid_unique").on(table.clientUuid),
    check("expense_payments_amount_positive_check", sql`${table.amount} > 0`),
    check(
      "expense_payments_method_valid_check",
      sql`${table.paymentMethod} in ('Cash', 'Mobile', 'Card')`,
    ),
  ],
);
