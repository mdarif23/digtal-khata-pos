import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import type { EncryptedSecret } from "../../utils/encryption.js";

/**
 * Per-business payment provider configuration for SALE payments
 * (bKash/Nagad/SSLCommerz merchant accounts belong to each tenant, unlike
 * the platform-level subscription gateway in config/env.ts).
 *
 * Credentials are AES-256-GCM encrypted at rest (utils/encryption.ts) and
 * are NEVER returned to any client — they are decrypted only server-side
 * when the provider client is constructed.
 */
export const paymentProviderConfigs = pgTable(
  "payment_provider_configs",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    provider: varchar({ length: 40 }).notNull(), // sslcommerz | mock | (future: bkash, nagad, shurjopay)
    mode: varchar({ length: 10 }).notNull().default("sandbox"), // sandbox | live
    enabled: boolean().notNull().default(true),
    credentialsEncrypted: jsonb("credentials_encrypted")
      .$type<EncryptedSecret>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("payment_provider_configs_business_provider_unique").on(
      t.businessId,
      t.provider,
    ),
    index("payment_provider_configs_business_idx").on(t.businessId),
    check("payment_provider_configs_mode_valid", sql`${t.mode} in ('sandbox','live')`),
  ],
);
