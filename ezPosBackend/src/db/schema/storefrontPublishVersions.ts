import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { storefronts } from "./storefronts.js";

/**
 * Immutable snapshot of a storefront's full public configuration at the
 * moment of publish. The live renderer reads ONLY these rows; restoring a
 * previous version republishes that snapshot as a new version. Rows are
 * never mutated after insert.
 */
export const storefrontPublishVersions = pgTable(
  "storefront_publish_versions",
  {
    id: serial().primaryKey().notNull(),
    storefrontId: integer("storefront_id")
      .notNull()
      .references(() => storefronts.id, { onDelete: "cascade" }),
    /** Monotonic per storefront, starting at 1. */
    versionNumber: integer("version_number").notNull(),
    themeId: varchar("theme_id", { length: 50 }).notNull(),
    /** Full validated theme config captured at publish time. */
    config: jsonb().$type<Record<string, unknown>>().notNull(),
    seo: jsonb().$type<Record<string, unknown>>(),
    /** Contact/social snapshot so the live site is fully self-contained. */
    contact: jsonb().$type<Record<string, unknown>>(),
    publishedByUserId: integer("published_by_user_id"),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("storefront_publish_versions_unique").on(
      table.storefrontId,
      table.versionNumber,
    ),
    index("storefront_publish_versions_storefront_idx").on(table.storefrontId),
  ],
);
