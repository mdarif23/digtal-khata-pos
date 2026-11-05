import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";
import { posTerminals } from "./posTerminals.js";
import { productVariants } from "./productVariants.js";
import { users } from "./users.js";

/**
 * Offline stock allocations (Phase 3). When a terminal goes offline it
 * may sell up to its server-granted allowance per variant — the allowance
 * is a SERVER-side ledger row, computed against current stock minus every
 * other terminal's active allowance, and non-reusable by two terminals
 * (partial unique index in migration 0051: one ACTIVE allocation per
 * terminal+variant). consumed_qty records what actually sold offline;
 * overages never silently extend an allowance.
 */
export const offlineAllocations = pgTable(
  "offline_allocations",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    locationId: integer("location_id").notNull(),
    terminalId: integer("terminal_id")
      .notNull()
      .references(() => posTerminals.id, { onDelete: "cascade" }),
    variantId: integer("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    allocatedQty: integer("allocated_qty").notNull(),
    consumedQty: integer("consumed_qty").default(0).notNull(),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // (terminal_id, variant_id) WHERE status='active' is migration-only
    // (this drizzle version's index builder cannot express partial uniques).
    index("offline_allocations_active_idx")
      .on(table.businessId, table.variantId)
      .where(sql`${table.status} = 'active'`),
  ],
);

/**
 * Conflict records (Phase 3): sync ops that would be unsafe to auto-apply
 * are either auto-applied WITH a conflict note (open-mode negative stock)
 * or parked for manager review. Financial rows are append-only — conflicts
 * never rewrite balances silently.
 */
export const syncConflicts = pgTable(
  "sync_conflicts",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    terminalId: integer("terminal_id").references(() => posTerminals.id, {
      onDelete: "set null",
    }),
    opId: varchar("op_id", { length: 120 }).notNull(),
    opType: varchar("op_type", { length: 50 }).notNull(),
    reason: varchar("reason", { length: 50 }).notNull(),
    message: text("message").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: varchar("status", { length: 30 }).default("open").notNull(),
    resolvedBy: integer("resolved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("sync_conflicts_open_idx")
      .on(table.businessId, table.status)
      .where(sql`${table.status} = 'open'`),
  ],
);

export type OfflineConflictReason =
  | "negative_stock_open_mode"
  | "allocation_exceeded"
  | "batch_shortfall"
  | "refund_cap_exceeded";
