import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";
import { users } from "./users.js";

/**
 * Stock-count sessions (Module 2: barcode stocktaking + cycle counting).
 *
 * A session freezes the EXPECTED (system) quantities at creation; counting
 * submits physical quantities per variant (partial counts are fine); the
 * variance is computed AT APPROVAL against the CURRENT stock (FOR UPDATE),
 * so concurrent sales/transfers between count and approval can never
 * produce an inconsistent adjustment — the delta applied is
 * counted − current, not counted − frozen.
 *
 * Lifecycle: open → (counting happens in place) → completed | cancelled.
 * Approval (inventory.adjust) applies the deltas + writes movements + audit;
 * every line keeps counted_by/at and the session keeps approved_by.
 */
export const stockCountSessions = pgTable(
  "stock_count_sessions",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    locationId: integer("location_id").notNull(),
    status: varchar({ length: 20 }).notNull().default("open"),
    /** Optional label, e.g. "Cycle count — aisle 4". */
    note: text(),
    /** Filters applied at creation (for the report UI). */
    scope: jsonb().$type<{ categoryIds?: number[]; variantIds?: number[] }>(),
    createdByUserId: integer("created_by_user_id")
      .notNull()
      .references(() => users.id),
    approvedByUserId: integer("approved_by_user_id").references(
      () => users.id,
    ),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.locationId, t.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "stock_count_sessions_location_business_fkey",
    }),
    index("stock_count_sessions_business_idx").on(t.businessId, t.locationId),
    check(
      "stock_count_sessions_status_valid",
      sql`${t.status} in ('open','completed','cancelled')`,
    ),
  ],
);



export const stockCountLines = pgTable(
  "stock_count_lines",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    sessionId: integer("session_id").notNull(),
    variantId: integer("variant_id").notNull(),
    /** System quantity when the line was created (the frozen expectation). */
    expectedQuantity: integer("expected_quantity").notNull(),
    /** Physical quantity entered by the counter; NULL = not counted yet. */
    countedQuantity: integer("counted_quantity"),
    countedByUserId: integer("counted_by_user_id").references(() => users.id),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("stock_count_lines_session_variant_unique").on(
      t.sessionId,
      t.variantId,
    ),
    index("stock_count_lines_session_idx").on(t.sessionId),
    check(
      "stock_count_lines_counted_nonnegative",
      sql`${t.countedQuantity} is null or ${t.countedQuantity} >= 0`,
    ),
  ],
);
