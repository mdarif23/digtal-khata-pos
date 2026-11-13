import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businesses } from "./businesses.js";
import { users } from "./users.js";

/**
 * Per-user manager PIN (Phase 1 — master prompt F12-D). PINs are individual,
 * never shared: each approver proves THEIR identity + authority with their
 * own secret. pin_hash is argon2 (same hasher as login passwords); plaintext
 * is never stored or logged. failed_attempts + locked_until implement the
 * brute-force lockout (MAX_PIN_FAILURES / PIN_LOCKOUT_MINUTES in
 * services/managerApproval.ts).
 */
export const managerPins = pgTable(
  "manager_pins",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pinHash: text("pin_hash").notNull(),
    failedAttempts: integer("failed_attempts").default(0).notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("manager_pins_business_user_uq").on(table.businessId, table.userId),
  ],
);

/**
 * One-time, op-bound, expiring approval tokens (Phase 1). verify-pin mints a
 * row and returns the raw token exactly once; only token_hash (sha-256) is
 * stored. The consuming endpoint must present the SAME payload — payload_hash
 * binds the approval to the exact operation being approved.
 */
export const managerApprovals = pgTable(
  "manager_approvals",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    approverUserId: integer("approver_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Dot-namespaced operation, e.g. "register.reopen", "sale.refund". */
    opType: varchar("op_type", { length: 60 }).notNull(),
    entityType: varchar("entity_type", { length: 40 }),
    entityId: integer("entity_id"),
    /** sha-256 of the canonical JSON payload the approval was minted for. */
    payloadHash: varchar("payload_hash", { length: 64 }),
    reason: text(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("manager_approvals_token_idx").on(table.tokenHash),
    index("manager_approvals_business_created_idx").on(
      table.businessId,
      table.createdAt,
    ),
    check(
      "manager_approvals_op_type_check",
      sql`char_length(${table.opType}) > 0`,
    ),
  ],
);
