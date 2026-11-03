import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sales } from "./sales.js";
import { businesses } from "./businesses.js";
import { users } from "./users.js";

/**
 * Append-only per-order timeline. One row per meaningful order event —
 * status transitions, confirmations, packing, shipping, delivery, COD
 * collection, channel imports, cancellations and returns. Rows are never
 * updated or deleted; statuses are denormalized display labels
 * (sale.status / fulfillment_status values).
 */
export const saleOrderEvents = pgTable(
  "sale_order_events",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    saleId: integer("sale_id").notNull(),
    eventType: varchar("event_type", { length: 40 }).notNull(),
    previousStatus: varchar("previous_status", { length: 30 }),
    newStatus: varchar("new_status", { length: 30 }),
    /** user | system | integration */
    actorType: varchar("actor_type", { length: 20 })
      .default("user")
      .notNull(),
    actorUserId: integer("actor_user_id").references(() => users.id),
    /** Display label when there is no user (e.g. 'WooCommerce webhook'). */
    actorLabel: varchar("actor_label", { length: 120 }),
    note: text(),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.saleId, table.businessId],
      foreignColumns: [sales.id, sales.businessId],
      name: "sale_order_events_sale_business_fkey",
    }),
    index("sale_order_events_sale_created_idx").on(
      table.saleId,
      table.createdAt,
    ),
    index("sale_order_events_business_id_idx").on(table.businessId),
  ],
);
