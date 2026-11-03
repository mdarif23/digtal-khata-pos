import {
  boolean,
  check,
  integer,
  numeric,
  pgTable,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businesses } from "./businesses.js";

/**
 * Price-increase alert configuration, one row per business. When a
 * supplier's latest actual purchase price for a variant rises more than
 * `increaseThresholdPercent` over that supplier's previous actual price,
 * a `price_increase` notification is created (deduped per price event).
 * Disabled by default — the owner opts in and picks the threshold.
 */
export const priceAlertSettings = pgTable(
  "price_alert_settings",
  {
    businessId: integer("business_id")
      .primaryKey()
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    increaseThresholdPercent: numeric("increase_threshold_pct", {
      precision: 5,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(10),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "price_alert_settings_threshold_check",
      sql`${table.increaseThresholdPercent} > 0`,
    ),
  ],
);
