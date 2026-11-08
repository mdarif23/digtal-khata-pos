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
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";
import { users } from "./users.js";

/**
 * Server-side held sales (Module 1 shared holds / Module 11 multi-register).
 * A held cart is stored per business+location so ANY authorized cashier at
 * ANY register can retrieve it — replacing the old localStorage-only holds
 * that were invisible across devices.
 *
 * items is the slim, serializable cart snapshot: variantId, quantity,
 * discount, serialNumbers, productName. Prices and stock are NOT trusted
 * from the hold — on resume the register uses live catalog data and the
 * backend re-validates everything at sale time. UOM lines (migration 0062)
 * carry uomConversionId + enteredQuantity; on resume the factor is
 * re-resolved from the (possibly reconfigured) packaging row, consistent
 * with the not-trusted-prices contract.
 */
export const heldSales = pgTable(
  "held_sales",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    locationId: integer("location_id").notNull(),
    heldByUserId: integer("held_by_user_id")
      .notNull()
      .references(() => users.id),
    name: varchar({ length: 120 }).notNull(),
    items: jsonb()
      .$type<
        {
          variantId: number;
          quantity: number;
          discount?: { type: "percentage" | "fixed"; value: number } | null;
          serialNumbers?: string[];
          productName: string;
          uomConversionId?: number | null;
          enteredQuantity?: number | null;
        }[]
      >()
      .notNull(),
    note: text(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.locationId, t.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "held_sales_location_business_fkey",
    }),
    index("held_sales_business_location_idx").on(t.businessId, t.locationId),
    index("held_sales_expires_idx").on(t.expiresAt),
    check(
      "held_sales_items_nonempty",
      sql`jsonb_array_length(${t.items}) > 0`,
    ),
  ],
);
