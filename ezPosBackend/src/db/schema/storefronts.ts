import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { storefrontStatusEnum } from "./storefrontEnums.js";

/** Storefront-level SEO fields editable from the portal. */
export interface StorefrontSeo {
  title?: string;
  description?: string;
  ogImageMediaId?: number;
}

/** Contact details + social links surfaced on the storefront. */
export interface StorefrontContact {
  phone?: string;
  email?: string;
  address?: string;
  social?: {
    facebook?: string;
    instagram?: string;
    whatsapp?: string;
  };
}

/**
 * A hosted storefront: the customer's online shop inside the ezPos website
 * platform. Always owned by exactly one existing business (products, orders
 * and inventory stay in the business — nothing is duplicated here).
 *
 * `draft_config` holds the theme customization being edited; the LIVE site
 * renders only from the immutable `storefront_publish_versions` snapshot
 * pointed to by `published_version_id`, so draft edits never touch production.
 * The FK to versions is enforced in service code (versions cascade on
 * storefront delete) to avoid a circular reference at the schema level.
 */
export const storefronts = pgTable(
  "storefronts",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: varchar({ length: 100 }).notNull(),
    /** Subdomain under the platform base domain; globally unique. */
    subdomain: varchar({ length: 63 }).notNull().unique(),
    status: storefrontStatusEnum("status").default("draft").notNull(),
    /** Theme registry id (e.g. "fashion-aura"); validated against the registry. */
    themeId: varchar("theme_id", { length: 50 }).notNull(),
    draftConfig: jsonb("draft_config")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    publishedVersionId: integer("published_version_id"),
    seo: jsonb().$type<StorefrontSeo>(),
    contact: jsonb().$type<StorefrontContact>(),
    storePickupEnabled: boolean("store_pickup_enabled")
      .default(false)
      .notNull(),
    analyticsEnabled: boolean("analytics_enabled").default(false).notNull(),
    /** Search-engine indexing preference (drives robots/sitemap responses). */
    searchIndexingEnabled: boolean("search_indexing_enabled")
      .default(true)
      .notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("storefronts_business_idx").on(table.businessId)],
);
