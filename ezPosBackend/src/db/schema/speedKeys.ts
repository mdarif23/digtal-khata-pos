import { sql } from "drizzle-orm";
import {
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
import { users } from "./users.js";

/**
 * Speed keys / visual product grid (Phase 3 — master prompt Feature 2).
 * Tiles REFERENCE existing variants — they never duplicate products.
 * Resolution order: user layout > register layout > business layout.
 */
export interface SpeedKeyTile {
  variantId: number;
  label: string;
  color: string;
  sortOrder: number;
}

export const speedKeyLayouts = pgTable(
  "speed_key_layouts",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /** business (scope_id 0) | user (user id) | register (register id). */
    scopeType: varchar("scope_type", { length: 10 }).notNull(),
    scopeId: integer("scope_id").notNull().default(0),
    tiles: jsonb("tiles").$type<SpeedKeyTile[]>().notNull().default(sql`'[]'::jsonb`),
    updatedBy: integer("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("speed_key_layouts_scope_uq").on(
      t.businessId,
      t.scopeType,
      t.scopeId,
    ),
    index("speed_key_layouts_business_idx").on(t.businessId),
  ],
);
