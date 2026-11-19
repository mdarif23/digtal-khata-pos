import {
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
  numeric,
} from "drizzle-orm/pg-core";
import { purchases } from "./purchases.js";
import { suppliers } from "./suppliers.js";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";

export const purchaseReturns = pgTable(
  "purchase_returns",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    purchaseId: integer("purchase_id").notNull(),
    /** Nullable (migration 0093): walk-in purchases have no supplier — the
     * return's credit-note insert is skipped for them. */
    supplierId: integer("supplier_id"),
    returnDate: timestamp("return_date", { mode: "string" })
      .defaultNow()
      .notNull(),
    reason: text(),
    status: varchar({ length: 20 }).default("pending").notNull(),
    // Owning outlet for this transaction. Nullable for legacy rows; the
    // application always sets it on new writes. Composite FK guarantees the
    // location belongs to the same business.
    locationId: integer("location_id"),
    totalAmount: numeric("total_amount", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "purchase_returns_location_business_fkey",
    }),
    index("purchase_returns_business_location_idx").on(table.businessId, table.locationId),
    index("purchase_returns_business_id_idx").on(table.businessId),
    unique("purchase_returns_id_business_uq").on(table.id, table.businessId),
    foreignKey({
      columns: [table.purchaseId, table.businessId],
      foreignColumns: [purchases.id, purchases.businessId],
      name: "purchase_returns_purchase_business_fkey",
    }),
    foreignKey({
      columns: [table.supplierId, table.businessId],
      foreignColumns: [suppliers.id, suppliers.businessId],
      name: "purchase_returns_supplier_business_fkey",
    }),
  ],
);
