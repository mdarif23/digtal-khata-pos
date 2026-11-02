import {
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { storefronts } from "./storefronts.js";
import { storefrontAnalyticsEventTypeEnum } from "./storefrontEnums.js";

/**
 * Lightweight storefront analytics beacons (stage 6 adds the rollup/portal
 * surface). Inserts are fire-and-forget from the renderer and rate-limited;
 * only aggregate counts are ever shown — no shopper identities are stored.
 */
export const storefrontAnalyticsEvents = pgTable(
  "storefront_analytics_events",
  {
    id: serial().primaryKey().notNull(),
    storefrontId: integer("storefront_id")
      .notNull()
      .references(() => storefronts.id, { onDelete: "cascade" }),
    eventType: storefrontAnalyticsEventTypeEnum("event_type").notNull(),
    path: varchar({ length: 300 }),
    productId: integer("product_id"),
    /** First-party visitor cookie id — random, not PII-linked. */
    visitorRef: varchar("visitor_ref", { length: 64 }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("storefront_analytics_events_storefront_idx").on(
      table.storefrontId,
      table.occurredAt,
    ),
  ],
);
