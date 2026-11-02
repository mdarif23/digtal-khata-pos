import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { users } from "./users.js";

/**
 * In-app notifications for the portal (Phase: portal completion).
 * Business-owner scoped: rows are keyed by business so the whole
 * ownership group sees them, with userId optional for direct messages.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    type: varchar({ length: 40 }).notNull(),
    title: varchar({ length: 200 }).notNull(),
    body: text(),
    entityType: varchar("entity_type", { length: 30 }),
    entityId: integer("entity_id"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("notifications_business_idx").on(table.businessId, table.createdAt),
    index("notifications_unread_idx").on(table.businessId, table.readAt),
  ],
);
