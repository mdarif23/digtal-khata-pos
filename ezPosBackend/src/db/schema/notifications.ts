import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { users } from "./users.js";

/**
 * Notification center (Module 14). Generated from real backend events with
 * deduplication (the dedupe_key suppresses repeats per day — the unique
 * index is on business+key+day), per-user read state, and per-user
 * per-kind muting. Delivered in-app over the SSE stream.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    kind: varchar({ length: 40 }).notNull(), // low_stock | out_of_stock | expiring_inventory | register_discrepancy | integration_failure | system
    severity: varchar({ length: 10 }).notNull().default("info"),
    title: varchar({ length: 120 }).notNull(),
    body: text(),
    payload: jsonb().$type<Record<string, unknown>>(),
    /** Repeats with the same key on the same day are suppressed. */
    dedupeKey: varchar("dedupe_key", { length: 120 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("notifications_business_created_idx").on(t.businessId, t.createdAt),
    // dedupeKey composes the day itself (key:YYYY-MM-DD, set by the
    // service) so the same event repeats at most once per day.
    unique("notifications_dedupe_idx").on(t.businessId, t.dedupeKey),
  ],
);

/** Per-user read state — notifications are business-wide, reads are mine. */
export const notificationReads = pgTable(
  "notification_reads",
  {
    notificationId: integer("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.notificationId, t.userId] })],
);

/** Extra primary key via composite — expressed as a unique for drizzle. */
export const notificationPrefs = pgTable(
  "notification_prefs",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: varchar({ length: 40 }).notNull(),
    muted: boolean("muted").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.kind] }),
  ],
);
