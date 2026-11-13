import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";
import { users } from "./users.js";
import { posTerminals } from "./posTerminals.js";
import { paymentAccounts } from "./paymentAccounts.js";

/** One row of a counted cash sheet — value of the note/coin and its count. */
export interface DenominationCount {
  value: number;
  count: number;
}

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
    /**
     * Finance & Growth: the cash payment account (payment_accounts) this
     * drawer's balance posts to. Nullable — unassigned drawers post to the
     * business's default cash account.
     */
    paymentAccountId: integer("payment_account_id"),
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
    foreignKey({
      columns: [table.paymentAccountId, table.businessId],
      foreignColumns: [paymentAccounts.id, paymentAccounts.businessId],
      name: "registers_payment_account_business_fkey",
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
    /**
     * Terminal attribution (multi-terminal Phase 1): the PC whose drawer is
     * being counted. Nullable — sessions opened before terminal binding (or
     * from an unbound PC) have none.
     */
    terminalId: integer("terminal_id"),
    /**
     * Offline idempotency (Phase 3): the browser-generated session UUID for
     * a drawer opened while offline. Unique partial index (migration 0051)
     * makes replays of a queued open a no-op.
     */
    clientSessionId: uuid("client_session_id"),
    /**
     * Phase 1 denomination snapshot taken at open —
     * [{ value: 500, count: 4 }, ...]. The rendered total must equal
     * opening_cash (service-validated); history never depends on the
     * current denomination configuration.
     */
    openingDenominations: jsonb("opening_denominations")
      .$type<DenominationCount[]>(),
    /** Phase 1 denomination snapshot taken at close (same shape). */
    countedDenominations: jsonb("counted_denominations")
      .$type<DenominationCount[]>(),
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
    // At most one OPEN session per user+terminal. Declared in migration
    // 0049 as NULLS NOT DISTINCT — this drizzle version's index builder
    // cannot express that, so it is intentionally NOT declared here (a
    // drizzle-kit generate would not see it; this repo hand-writes SQL).
    // Semantics: NULLS NOT DISTINCT preserves one-open-session-per-user for
    // terminal-less sessions; two open sessions on DIFFERENT terminals may
    // coexist only when the business enables allow_multiple_drawer_sessions
    // (the service gates it), and one terminal can never hold two.
    // Terminal-scoped session lookup for cash attribution (multi-terminal).
    index("register_sessions_open_terminal_idx")
      .on(table.terminalId)
      .where(sql`${table.status} = 'open'`),
    index("register_sessions_register_idx").on(table.registerId),
    foreignKey({
      columns: [table.registerId, table.businessId],
      foreignColumns: [registers.id, registers.businessId],
      name: "register_sessions_register_business_fkey",
    }),
    // The session's terminal must belong to the same business.
    foreignKey({
      columns: [table.terminalId, table.businessId],
      foreignColumns: [posTerminals.id, posTerminals.businessId],
      name: "register_sessions_terminal_business_fkey",
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
    /**
     * Offline idempotency (Phase 3): the browser-generated op UUID for a
     * drawer movement queued while offline (unique partial index).
     */
    clientOpId: varchar("client_op_id", { length: 120 }),
    note: text(),
    /**
     * Phase 1 cash-drop metadata (safe_deposit): who physically received the
     * money, a reference slip number, and a separate manager confirmation.
     */
    recipientUserId: integer("recipient_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    referenceNo: varchar("reference_no", { length: 60 }),
    confirmedBy: integer("confirmed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
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

/**
 * Per-business denomination sheet configuration (Phase 1): the note/coin
 * values cashiers count with, e.g. [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1].
 * Singleton row per business; absent row = the service offers a default set.
 * Values are service-validated (positive, unique, max 15 entries).
 */
export const registerDenominationConfigs = pgTable("register_denomination_configs", {
  businessId: integer("business_id")
    .primaryKey()
    .references(() => businesses.id, { onDelete: "cascade" }),
  denominations: jsonb("denominations").$type<number[]>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Mid-shift blind count (Phase 1). A reconciliation is a COUNT EVENT, not a
 * movement — it never changes expected cash; it records the interim variance
 * so a drawer drifting during a long shift is caught before close.
 * Composite FK to register_sessions(id, business_id) enforces tenancy.
 */
export const registerReconciliations = pgTable(
  "register_reconciliations",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    sessionId: integer("session_id").notNull(),
    expectedCash: numeric("expected_cash", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).notNull(),
    countedCash: numeric("counted_cash", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).notNull(),
    difference: numeric("difference", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).notNull(),
    countedDenominations: jsonb("counted_denominations")
      .$type<DenominationCount[]>(),
    notes: text(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("register_reconciliations_business_created_idx").on(
      table.businessId,
      table.createdAt,
    ),
    index("register_reconciliations_session_idx").on(table.sessionId),
    foreignKey({
      columns: [table.sessionId, table.businessId],
      foreignColumns: [registerSessions.id, registerSessions.businessId],
      name: "register_reconciliations_session_business_fkey",
    }),
    check(
      "register_reconciliations_amount_check",
      sql`${table.expectedCash} >= 0 AND ${table.countedCash} >= 0`,
    ),
  ],
);
