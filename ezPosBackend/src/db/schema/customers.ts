import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";

export const customers = pgTable(
  "customers",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    name: varchar({ length: 255 }).notNull(),
    phone: varchar({ length: 20 }),
    email: varchar({ length: 255 }),
    address: text(),
    /**
     * Current customer group (pricing, migration 0063). Plain FK (no
     * composite) — a composite FK with ON DELETE SET NULL would also NULL
     * the customer's business_id; the service verifies the group belongs to
     * the caller's business on every write (patchProduct precedent). NULL =
     * no group pricing. Group discounts snapshot onto sale lines.
     */
    customerGroupId: integer("customer_group_id"),
    /**
     * Stable cross-server identity (Phase 2): the LAN server generates it;
     * the cloud adopts the same UUID so offline-created customers map to
     * exactly one cloud row. NULL for cloud-native customers.
     */
    clientUuid: uuid("client_uuid"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("customers_business_id_idx").on(table.businessId),
    // Group-profitability and per-group customer listings.
    index("customers_customer_group_idx").on(table.customerGroupId),
    // Partial unique (business_id, client_uuid) WHERE NOT NULL is created
    // in migration 0050 — this drizzle version's constraint builder cannot
    // express the WHERE predicate (same as the open-session index).
  ],
);
