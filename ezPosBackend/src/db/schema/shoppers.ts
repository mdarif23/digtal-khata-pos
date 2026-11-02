import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businesses } from "./businesses.js";
import { storefronts } from "./storefronts.js";

/**
 * End-consumer accounts on a hosted storefront (stage 5). Optional per
 * storefront (`storefronts.shopper_accounts_enabled`); guest checkout
 * remains the default. Shopper credentials are FULLY isolated from ezPos
 * user accounts — separate table, separate sessions, separate tokens.
 */
export const shoppers = pgTable(
  "shoppers",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    storefrontId: integer("storefront_id")
      .notNull()
      .references(() => storefronts.id, { onDelete: "cascade" }),
    email: varchar({ length: 255 }).notNull(),
    /** Argon2 hash (@node-rs/argon2) — never stored or returned in clear. */
    passwordHash: varchar("password_hash", { length: 128 }).notNull(),
    fullName: varchar("full_name", { length: 120 }),
    phone: varchar({ length: 20 }),
    status: varchar({ length: 20 }).default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    // Emails are unique per storefront — the same person may shop at two
    // different stores with the same address, isolated from each other.
    unique("shoppers_storefront_email_unique").on(t.storefrontId, t.email),
    index("shoppers_business_idx").on(t.businessId),
    check("shoppers_status_valid", sql`${t.status} in ('active','suspended')`),
  ],
);

/**
 * Shopper sessions: opaque random bearer tokens, stored HASHED (sha256 —
 * high-entropy tokens do not need password hashing), 30-day expiry,
 * revocable per row like refresh tokens.
 */
export const shopperSessions = pgTable(
  "shopper_sessions",
  {
    id: serial().primaryKey().notNull(),
    shopperId: integer("shopper_id")
      .notNull()
      .references(() => shoppers.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("shopper_sessions_shopper_idx").on(t.shopperId)],
);
