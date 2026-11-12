import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { users } from "./users.js";

/**
 * Customer-facing display (Phase 3 — master prompt Feature 1). Pairing
 * follows the terminal pattern: one-time 8-char code, SHA-256-hashed with a
 * 10-minute TTL; the display token is shown once and stored hashed. The
 * display is strictly READ-ONLY — its token only reads the SSE stream and
 * its own snapshot; no sale-modifying endpoint accepts it.
 */
export const cfdPairings = pgTable(
  "cfd_pairings",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("cfd_pairings_code_idx").on(t.codeHash)],
);

export const cfdDisplays = pgTable(
  "cfd_displays",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    status: varchar("status", { length: 10 }).notNull().default("active"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    /** Last pushed cart snapshot (reconnect restore). */
    lastPayload: jsonb("last_payload"),
    payloadUpdatedAt: timestamp("payload_updated_at", { withTimezone: true }),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("cfd_displays_token_uq").on(t.tokenHash),
    index("cfd_displays_business_idx").on(t.businessId, t.status),
    check(
      "cfd_displays_status_check",
      sql`${t.status} IN ('active', 'revoked')`,
    ),
  ],
);
