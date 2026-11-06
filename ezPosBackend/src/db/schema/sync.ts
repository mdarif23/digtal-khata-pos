import {
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
// sync_id_map is business-scoped: the PK is (business_id, kind, local_id).

/**
 * LAN sync bookkeeping (Phase 2) — used by the local server's sync agent;
 * inert on a cloud deployment.
 *
 * sync_state: one row per pull stream ('identity' always full-snapshot,
 * 'catalog' / 'customers' watermark deltas) plus push/pull bookkeeping.
 * cursor is the watermark (ISO timestamp) the next delta pull resumes
 * from; NULL means "never pulled".
 *
 * sync_id_map: local→cloud id resolution for records whose keys differ
 * between servers (customers created on the LAN, adopted by the cloud via
 * client_uuid). Sales never need mapping — the agent rewrites the payload
 * customer id before pushing.
 */
export const syncState = pgTable("sync_state", {
  stream: varchar("stream", { length: 50 }).primaryKey(),
  cursor: text("cursor"),
  lastPushAt: timestamp("last_push_at", { withTimezone: true }),
  lastPullAt: timestamp("last_pull_at", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const syncIdMap = pgTable("sync_id_map", {
  businessId: integer("business_id").notNull(),
  kind: varchar("kind", { length: 50 }).notNull(),
  localId: integer("local_id").notNull(),
  remoteId: integer("remote_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
