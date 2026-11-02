import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { products } from "./products.js";
import { storefronts } from "./storefronts.js";

/**
 * Website-specific settings per product, scoped to ONE storefront so a
 * business with several storefronts can publish different assortments.
 *
 * Rows are opt-in: a product with no row here is NOT on the storefront.
 * Cost, supplier and private stock data are never stored or exposed here.
 */
export const storefrontProductVisibility = pgTable(
  "storefront_product_visibility",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    storefrontId: integer("storefront_id")
      .notNull()
      .references(() => storefronts.id, { onDelete: "cascade" }),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    published: boolean().default(true).notNull(),
    featured: boolean().default(false).notNull(),
    seoTitle: varchar("seo_title", { length: 200 }),
    seoDescription: varchar("seo_description", { length: 300 }),
    /** Storefront-only image URLs (typically CDN keys uploaded via media). */
    websiteImageUrls: text("website_image_urls").array(),
    sortOrder: integer("sort_order").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("storefront_product_visibility_unique").on(
      table.storefrontId,
      table.productId,
    ),
    index("storefront_product_visibility_storefront_idx").on(
      table.storefrontId,
      table.published,
    ),
  ],
);
