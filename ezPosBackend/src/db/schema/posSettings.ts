import {
  boolean,
  integer,
  numeric,
  pgTable,
  timestamp,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";

/**
 * Per-business POS operating policy (multi-terminal Phase 1). Singleton row
 * per business, created on demand — absent row means all defaults (false).
 *
 * require_terminal: when true, POS-family write routes reject requests that
 * carry no X-Terminal-Id header, so only registered, active terminals can
 * ring sales. Default off keeps every existing workflow untouched.
 *
 * allow_multiple_drawer_sessions: when true, one cashier may hold open
 * register sessions on two different terminals at once (the DB index
 * register_sessions_one_open_per_user permits that only when the terminal
 * ids differ; NULLS NOT DISTINCT keeps terminal-less sessions unique).
 */
export const posSettings = pgTable("pos_settings", {
  businessId: integer("business_id")
    .primaryKey()
    .references(() => businesses.id, { onDelete: "cascade" }),
  requireTerminal: boolean("require_terminal").default(false).notNull(),
  allowMultipleDrawerSessions: boolean("allow_multiple_drawer_sessions")
    .default(false)
    .notNull(),
  /** Offline allowance TTL (Phase 3): allocations expire after this long. */
  offlineAllocationTtlHours: integer("offline_allocation_ttl_hours")
    .default(24)
    .notNull(),
  /** Offline cash-refund ceiling; NULL = no offline refunds allowed. */
  offlineRefundCap: numeric("offline_refund_cap", {
    precision: 10,
    scale: 2,
    mode: "number",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
