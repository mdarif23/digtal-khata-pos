import { sql } from "drizzle-orm";
import {
  check,
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
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";
import { users } from "./users.js";

export const registerStatusEnum = pgEnum("register_status", [
  "active",
  "inactive",
]);

export const registerSessionStatusEnum = pgEnum("register_session_status", [
  "open",
  "closed",
]);

/**
 * Drawer movement types. Direction convention — INCREASING drawer cash:
 * sale (net cash portion), cash_in, safe_withdrawal (safe → drawer),
 * adjustment_in. DECREASING drawer cash: cash_out, cash_refund (counter
 * payout to the customer), safe_deposit (drawer → safe), adjustment_out.
 */
export const registerTransactionTypeEnum = pgEnum(
  "register_transaction_type",
  [
    "sale",
    "cash_in",
    "cash_out",
    "cash_refund",
    "safe_deposit",
    "safe_withdrawal",
    "adjustment_in",
    "adjustment_out",
  ],
);

/**
 * A cash drawer at a specific location. A location may have several
 * registers; each register holds at most one open session at a time.
 */
export const registers = pgTable(
  "registers",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    locationId: integer("location_id").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    status: registerStatusEnum("status").default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique("registers_location_name_unique").on(
      table.locationId,
      table.name,
    ),
    unique("registers_id_business_uq").on(table.id, table.businessId),
    index("registers_business_location_idx").on(
      table.businessId,
      table.locationId,
    ),
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "registers_location_business_fkey",
    }),
  ],
);

/**
 * A cashier's shift on a register. expectedCash is computed at close from
 * opening cash + recorded transactions (cash sales, cash in/out) and
 * compared against the counted drawer amount.
 */
export const registerSessions = pgTable(
  "register_sessions",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    registerId: integer("register_id").notNull(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: registerSessionStatusEnum("status").default("open").notNull(),
    openingCash: numeric("opening_cash", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).notNull(),
    expectedCash: numeric("expected_cash", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    countedCash: numeric("counted_cash", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    difference: numeric("difference", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    notes: text(),
    openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    // Candidate key for the composite FK from register_transactions.
    unique("register_sessions_id_business_uq").on(
      table.id,
      table.businessId,
    ),
    // At most one OPEN session per register — the drawer is physical.
    uniqueIndex("register_sessions_one_open_per_register")
      .on(table.registerId)
      .where(sql`${table.status} = 'open'`),
    // At most one OPEN session per user — keeps cash attribution
    // unambiguous when sales are auto-recorded to the cashier's drawer.
    uniqueIndex("register_sessions_one_open_per_user")
      .on(table.userId, table.businessId)
      .where(sql`${table.status} = 'open'`),
    index("register_sessions_register_idx").on(table.registerId),
    foreignKey({
      columns: [table.registerId, table.businessId],
      foreignColumns: [registers.id, registers.businessId],
      name: "register_sessions_register_business_fkey",
    }),
  ],
);

/**
 * Cash drawer movements. Cash portions of sales are recorded automatically
 * by the sale path; cash_refund by the refund path (counter payouts);
 * safe/adjustment types are manual drawer operations. amount is always
 * positive — the type determines the direction.
 */
export const registerTransactions = pgTable(
  "register_transactions",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    sessionId: integer("session_id").notNull(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    type: registerTransactionTypeEnum("type").notNull(),
    amount: numeric("amount", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).notNull(),
    referenceType: varchar("reference_type", { length: 50 }),
    referenceId: integer("reference_id"),
    note: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("register_transactions_session_idx").on(table.sessionId),
    // Idempotency: a source financial record (sale, sale_refund,
    // sale_payment, expense_payment) can produce at most one drawer
    // movement. Manual movements (reference_type 'manual', reference_id
    // NULL) are exempt via the partial predicate.
    uniqueIndex("register_transactions_reference_uq")
      .on(table.businessId, table.referenceType, table.referenceId)
      .where(
        sql`${table.referenceType} IS NOT NULL AND ${table.referenceId} IS NOT NULL AND ${table.referenceType} <> 'manual'`,
      ),
    foreignKey({
      columns: [table.sessionId, table.businessId],
      foreignColumns: [registerSessions.id, registerSessions.businessId],
      name: "register_transactions_session_business_fkey",
    }),
    check(
      "register_transactions_amount_check",
      sql`${table.amount} >= 0`,
    ),
  ],
);
