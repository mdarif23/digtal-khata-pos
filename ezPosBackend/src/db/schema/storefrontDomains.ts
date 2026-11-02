import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { storefronts } from "./storefronts.js";
import {
  storefrontDomainKindEnum,
  storefrontDomainStatusEnum,
  storefrontSslStatusEnum,
} from "./storefrontEnums.js";

/**
 * Domains attached to a storefront.
 *
 * - The default subdomain row is created with the storefront (kind=subdomain).
 * - Custom domains start `pending` with a TXT verification token; they only
 *   become `verified` after DNS proof, and only then may the edge issue TLS.
 *   ssl_status tracks certificate provisioning separately — a verified domain
 *   with ssl_status=pending is NOT yet connected.
 * - Domains are stored lowercase; uniqueness is global (one domain can only
 *   ever point at one storefront — this blocks cross-tenant hijacking).
 */
export const storefrontDomains = pgTable(
  "storefront_domains",
  {
    id: serial().primaryKey().notNull(),
    storefrontId: integer("storefront_id")
      .notNull()
      .references(() => storefronts.id, { onDelete: "cascade" }),
    kind: storefrontDomainKindEnum("kind").notNull(),
    domain: varchar({ length: 253 }).notNull().unique(),
    verificationToken: varchar("verification_token", { length: 64 }),
    status: storefrontDomainStatusEnum("status").default("pending").notNull(),
    sslStatus: storefrontSslStatusEnum("ssl_status").default("pending").notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("storefront_domains_storefront_idx").on(table.storefrontId),
    index("storefront_domains_status_idx").on(table.status),
  ],
);
