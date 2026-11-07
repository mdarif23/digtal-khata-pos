import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { purchases } from "./purchases.js";
import { purchaseItems } from "./purchaseItems.js";
import { users } from "./users.js";
import { purchaseReceivingRecords } from "./purchaseReceivingRecords.js";

/**
 * Discrepancy and resolution records (migration 0052) — the exception log
 * for purchase receiving:
 * - over_receival: accepted above ordered, with the approval trail.
 * - shortage: fewer units received than outstanding, with the resolution
 *   (receive_later | cancel | backordered).
 * - rejection: delivered goods refused, with category and reason; the
 *   resolution (supplier_credit | replacement) is recorded here only —
 *   credits are NEVER created automatically.
 * - cancellation: outstanding quantity cancelled from the receiving side.
 */
export const purchaseDiscrepancies = pgTable(
  "purchase_discrepancies",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id").notNull(),
    purchaseId: integer("purchase_id").notNull(),
    purchaseItemId: integer("purchase_item_id").notNull(),
    receivingRecordId: integer("receiving_record_id").references(
      () => purchaseReceivingRecords.id,
    ),
    type: varchar("type", { length: 20 }).notNull(),
    quantity: numeric("quantity", {
      precision: 12,
      scale: 3,
      mode: "number",
    }).notNull(),
    reason: text("reason"),
    category: varchar("category", { length: 30 }),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    resolution: varchar("resolution", { length: 20 }),
    requestedByUserId: integer("requested_by_user_id")
      .notNull()
      .references(() => users.id),
    resolvedByUserId: integer("resolved_by_user_id").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "purchase_discrepancies_type_check",
      sql`${table.type} IN ('over_receival','shortage','rejection','cancellation')`,
    ),
    check(
      "purchase_discrepancies_status_check",
      sql`${table.status} IN ('open','resolved','cancelled')`,
    ),
    check(
      "purchase_discrepancies_resolution_check",
      sql`${table.resolution} IS NULL OR ${table.resolution} IN ('receive_later','cancel','backordered','supplier_credit','replacement')`,
    ),
    foreignKey({
      columns: [table.purchaseId, table.businessId],
      foreignColumns: [purchases.id, purchases.businessId],
      name: "purchase_discrepancies_purchase_business_fkey",
    }),
    foreignKey({
      columns: [table.purchaseItemId, table.businessId],
      foreignColumns: [purchaseItems.id, purchaseItems.businessId],
      name: "purchase_discrepancies_item_business_fkey",
    }),
    index("purchase_discrepancies_purchase_idx").on(
      table.businessId,
      table.purchaseId,
    ),
  ],
);
