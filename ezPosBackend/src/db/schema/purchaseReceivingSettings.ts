import {
  check,
  integer,
  numeric,
  pgTable,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businesses } from "./businesses.js";

/**
 * Receiving configuration, one row per business (mirrors
 * price_alert_settings). `over_receive_tolerance_percent` is the share of
 * the ordered quantity a receiver may accept above the outstanding amount
 * WITHOUT the `purchases.over_receive` permission — over that, approval by
 * a permission holder is required. 0 (default) means every over-receive
 * needs approval. Recorded reasons/approvers live on
 * purchase_receiving_records / purchase_discrepancies.
 */
export const purchaseReceivingSettings = pgTable(
  "purchase_receiving_settings",
  {
    businessId: integer("business_id")
      .primaryKey()
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    overReceiveTolerancePercent: numeric("over_receive_tolerance_percent", {
      precision: 5,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "purchase_receiving_settings_tolerance_check",
      sql`${table.overReceiveTolerancePercent} >= 0`,
    ),
  ],
);
