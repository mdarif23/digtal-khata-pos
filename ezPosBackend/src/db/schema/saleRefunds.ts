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
import { sales } from "./sales.js";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";
export const saleRefunds = pgTable(
  "sale_refunds",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    saleId: integer("sale_id"),
    reason: text(),
    // Owning outlet for this transaction. Nullable for legacy rows; the
    // application always sets it on new writes. Composite FK guarantees the
    // location belongs to the same business.
    locationId: integer("location_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    status: varchar({ length: 20 }),
    refundTotal: numeric("refund_total", { mode: "number" }),
  },
  (table) => [
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "sale_refunds_location_business_fkey",
    }),
    index("sale_refunds_business_location_idx").on(table.businessId, table.locationId),
    index("sale_refunds_business_id_idx").on(table.businessId),
    unique("sale_refunds_id_business_uq").on(table.id, table.businessId),
    foreignKey({
      columns: [table.saleId, table.businessId],
      foreignColumns: [sales.id, sales.businessId],
      name: "refunds_sale_business_fkey",
    }),
  ],
);
