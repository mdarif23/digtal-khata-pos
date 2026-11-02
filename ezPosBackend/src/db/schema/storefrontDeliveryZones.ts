import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { storefronts } from "./storefronts.js";

/**
 * Delivery zones for a storefront's checkout: the shopper's area is matched
 * against `areas` (case-insensitive) and the charge is computed SERVER-SIDE
 * at checkout — the client's delivery fee is never trusted.
 *
 * Rates are amounts in the business currency (numeric, 2dp, mode:number).
 * Designed so courier-API integrations can later attach to a zone row
 * without changing checkout logic.
 */
export const storefrontDeliveryZones = pgTable(
  "storefront_delivery_zones",
  {
    id: serial().primaryKey().notNull(),
    storefrontId: integer("storefront_id")
      .notNull()
      .references(() => storefronts.id, { onDelete: "cascade" }),
    name: varchar({ length: 100 }).notNull(),
    areas: text().array().notNull(),
    rate: numeric({ precision: 10, scale: 2, mode: "number" }).notNull(),
    estimatedDaysMin: integer("estimated_days_min"),
    estimatedDaysMax: integer("estimated_days_max"),
    freeThreshold: numeric("free_threshold", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("storefront_delivery_zones_storefront_idx").on(table.storefrontId),
  ],
);
