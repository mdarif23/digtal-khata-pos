import {
  bigint,
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";

/**
 * Metadata for storefront media uploaded to object storage (MinIO now,
 * R2/S3 later). Bytes are never proxied through the API — the browser PUTs
 * directly to a presigned URL, then registers the object here.
 *
 * objectKey layout: `businesses/{businessId}/storefront/{uuid}.{ext}` —
 * the per-business prefix is the storage-isolation boundary; public reads
 * go through the CDN host with long-lived cache headers.
 */
export const storefrontMedia = pgTable(
  "storefront_media",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    objectKey: varchar("object_key", { length: 300 }).notNull().unique(),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 100 }).notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    width: integer(),
    height: integer(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("storefront_media_business_idx").on(table.businessId)],
);
