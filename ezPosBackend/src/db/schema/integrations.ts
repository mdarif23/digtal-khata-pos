import {
  index,
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import {
  integrationPlatformEnum,
  integrationStatusEnum,
} from "./commerceEnums.js";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";

/**
 * A connected external storefront (WooCommerce store, custom website).
 * The commerce core never talks to a platform directly — everything goes
 * through platform adapters; this table is the adapter-neutral record.
 * Platform credentials live in integration_credentials (Phase 9.3),
 * encrypted at rest, never in this table.
 */
export const integrations = pgTable(
  "integrations",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    platform: integrationPlatformEnum("platform").notNull(),
    name: varchar({ length: 120 }).notNull(),
    storeUrl: varchar("store_url", { length: 255 }),
    /** Which ezPos location fulfills this channel's orders. */
    locationId: integer("location_id").references(() => locations.id, {
      onDelete: "set null",
    }),
    status: integrationStatusEnum("status").default("connected").notNull(),
    /** Route token embedded in the WooCommerce webhook delivery URL; also
     * the HMAC secret for signature verification. */
    webhookSecret: varchar("webhook_secret", { length: 64 }).unique(),
    /** Per-field-group sync direction policy (see architecture doc §7). */
    syncPolicy: jsonb("sync_policy")
      .$type<Record<string, string>>(),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    /** Outbound customer push (Module 12) — on by default for new connects. */
    customerSyncEnabled: boolean("customer_sync_enabled")
      .notNull()
      .default(true),
    customerSyncedAt: timestamp("customer_synced_at", { withTimezone: true }),
    health: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("integrations_business_idx").on(table.businessId),
    unique("integrations_id_business_uq").on(table.id, table.businessId),
  ],
);
