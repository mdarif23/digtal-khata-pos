import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  serial,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { productVariants } from "./productVariants.js";

/**
 * Supplier lead times per variant (Phase 4 — master prompt Feature 14):
 * reorder forecasting covers lead-time demand when a velocity is known.
 */
export const supplierLeadTimes = pgTable(
  "supplier_lead_times",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    supplierId: integer("supplier_id").notNull(),
    variantId: integer("variant_id").notNull(),
    leadTimeDays: integer("lead_time_days").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("supplier_lead_times_uq").on(
      t.businessId,
      t.supplierId,
      t.variantId,
    ),
    check(
      "supplier_lead_times_check",
      sql`${t.leadTimeDays} BETWEEN 0 AND 365`,
    ),
    foreignKey({
      columns: [t.variantId, t.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "supplier_lead_times_variant_business_fkey",
    }),
  ],
);
