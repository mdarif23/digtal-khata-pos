import {
  boolean,
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
 * A content block is a typed, structured element (heading, paragraph, image,
 * faq item, contact block) — never raw HTML/JS. The allowed block shapes are
 * validated by zod at write time; this loose type only documents intent.
 */
export type StorefrontPageBlock = Record<string, unknown>;

/**
 * Customer-managed content pages (About Us, policies, delivery info…).
 * Slugs are unique per storefront and map to /pages/<slug> on the storefront.
 */
export const storefrontPages = pgTable(
  "storefront_pages",
  {
    id: serial().primaryKey().notNull(),
    storefrontId: integer("storefront_id")
      .notNull()
      .references(() => storefronts.id, { onDelete: "cascade" }),
    slug: varchar({ length: 100 }).notNull(),
    title: varchar({ length: 200 }).notNull(),
    blocks: jsonb().$type<StorefrontPageBlock[]>().default([]).notNull(),
    seoTitle: varchar("seo_title", { length: 200 }),
    seoDescription: varchar("seo_description", { length: 300 }),
    isPublished: boolean("is_published").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("storefront_pages_slug_unique").on(table.storefrontId, table.slug),
    index("storefront_pages_storefront_idx").on(table.storefrontId),
  ],
);
