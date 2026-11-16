import {
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { sales } from "./sales.js";
import { users } from "./users.js";

/**
 * P3 Phase 4 (N1-10, migration 0087): secure expiring receipt share links.
 * Tokens are stored ONLY as SHA-256 hashes — the plaintext is returned once
 * at creation (the CFD display-token model) and never recoverable. Links
 * expire and are revocable; an expired/revoked token resolves to nothing,
 * so customer data is never permanently publicly reachable. The composite
 * sale FK keeps a link pinned to its own tenant's sale.
 */
export const receiptShareTokens = pgTable(
  "receipt_share_tokens",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    saleId: integer("sale_id").notNull(),
    /** SHA-256 of the plaintext token — unique across the system. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("receipt_share_tokens_business_sale_idx").on(t.businessId, t.saleId),
    foreignKey({
      columns: [t.saleId, t.businessId],
      foreignColumns: [sales.id, sales.businessId],
      name: "receipt_share_tokens_sale_business_fkey",
    }),
  ],
);
