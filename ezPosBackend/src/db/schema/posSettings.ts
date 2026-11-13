import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";

/**
 * Which sensitive operations demand a manager approval token (Phase 1).
 * Keys are ManagerOpType values; an absent key means "not required".
 * register_reopen is ALWAYS approval-gated (code-enforced) and therefore
 * deliberately not configurable here.
 */
export type ApprovalRequiredConfig = {
  sale_refund?: boolean;
  sale_cancel?: boolean;
  cash_movement?: boolean;
  below_minimum_price?: boolean;
};

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
  /**
   * Phase 1: when true, cash sales are rejected unless the seller (or their
   * terminal) has an open register session — closes the "cash sold with no
   * drawer open, movement silently dropped" hole. Default off (previous
   * behaviour).
   */
  requireOpenDrawer: boolean("require_open_drawer").default(false).notNull(),
  /** Phase 1: per-operation manager-approval requirements (see type above). */
  approvalRequired: jsonb("approval_required")
    .$type<ApprovalRequiredConfig>()
    .default({})
    .notNull(),
  /**
   * Phase 4 (Feature 10-B): embedded price/weight barcode parse config —
   * { prefixes, pluLength, valueLength, decimals, mode, hasCheckDigit }.
   */
  embeddedBarcode: jsonb("embedded_barcode").$type<{
    prefixes: string[];
    pluLength: number;
    valueLength: number;
    decimals: number;
    mode: "weight" | "price";
    hasCheckDigit: boolean;
  } | null>(),
  /** Phase 3 CFD: idle-screen copy shown when the customer display has no cart. */
  cfdIdleMessage: varchar("cfd_idle_message", { length: 200 }),
  /** Phase 3 CFD: promotional banner copy on the idle screen. */
  cfdPromoMessage: varchar("cfd_promo_message", { length: 200 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
