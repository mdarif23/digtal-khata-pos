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
    // Partial unique (business_id, client_uuid) WHERE NOT NULL is created
    // in migration 0050 — this drizzle version's constraint builder cannot
    // express the WHERE predicate (same as the open-session index).
  ],
);
