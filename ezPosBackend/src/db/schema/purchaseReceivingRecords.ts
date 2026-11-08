import {
  boolean,
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
import { productVariants } from "./productVariants.js";
import { productUnitConversions } from "./productUnitConversions.js";
import { locations } from "./locations.js";
import { users } from "./users.js";

/**
 * Per-delivery audit trail (migration 0052): one row per purchase item per
 * receiving submission, recording the delivered/accepted/rejected split,
 * the unit cost as entered, rejection details, and who received/approved.
 *
 * Rejected goods never enter inventory (no batches, stock, or movements) —
 * this table plus purchase_discrepancies IS the audit trail for them.
 * Over-receiving beyond the business's tolerance records the approver here.
 */
export const purchaseReceivingRecords = pgTable(
  "purchase_receiving_records",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id").notNull(),
    purchaseId: integer("purchase_id").notNull(),
    purchaseItemId: integer("purchase_item_id").notNull(),
    variantId: integer("variant_id").notNull(),
    locationId: integer("location_id").notNull(),
    deliveredQuantity: numeric("delivered_quantity", {
      precision: 12,
      scale: 3,
      mode: "number",
    }).notNull(),
    acceptedQuantity: numeric("accepted_quantity", {
      precision: 12,
      scale: 3,
      mode: "number",
    }).notNull(),
    rejectedQuantity: numeric("rejected_quantity", {
      precision: 12,
      scale: 3,
      mode: "number",
    })
      .notNull()
      .default(0),
    unitCost: numeric("unit_cost", { precision: 14, scale: 6, mode: "number" }).notNull(),
    /**
     * UOM snapshot (migration 0062): what the operator typed at this
     * receiving session (e.g. 6 Box @ ৳1,200/box, factor 12). Stored
     * delivered/accepted/rejected quantities and unitCost stay BASE-unit.
     */
    uomConversionId: integer("uom_conversion_id"),
    enteredQuantity: numeric("entered_quantity", {
      precision: 12,
      scale: 3,
      mode: "number",
    }),
    enteredUnitPrice: numeric("entered_unit_price", {
      precision: 14,
      scale: 6,
      mode: "number",
    }),
    conversionFactor: numeric("conversion_factor", {
      precision: 14,
      scale: 6,
      mode: "number",
    }),
    rejectionCategory: varchar("rejection_category", { length: 30 }),
    rejectionReason: text("rejection_reason"),
    overReceived: boolean("over_received").notNull().default(false),
    approvalReason: text("approval_reason"),
    receivedByUserId: integer("received_by_user_id")
      .notNull()
      .references(() => users.id),
    approvedByUserId: integer("approved_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "purchase_receiving_records_quantities_check",
      sql`${table.acceptedQuantity} >= 0 AND ${table.rejectedQuantity} >= 0 AND ${table.deliveredQuantity} = ${table.acceptedQuantity} + ${table.rejectedQuantity}`,
    ),
    check(
      "purchase_receiving_records_rejection_reason_check",
      sql`${table.rejectedQuantity} = 0 OR (${table.rejectionCategory} IS NOT NULL AND ${table.rejectionReason} IS NOT NULL)`,
    ),
    foreignKey({
      columns: [table.purchaseId, table.businessId],
      foreignColumns: [purchases.id, purchases.businessId],
      name: "purchase_receiving_records_purchase_business_fkey",
    }),
    foreignKey({
      columns: [table.purchaseItemId, table.businessId],
      foreignColumns: [purchaseItems.id, purchaseItems.businessId],
      name: "purchase_receiving_records_item_business_fkey",
    }),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "purchase_receiving_records_variant_business_fkey",
    }),
    foreignKey({
      columns: [table.uomConversionId, table.businessId],
      foreignColumns: [productUnitConversions.id, productUnitConversions.businessId],
      name: "prr_uom_business_fkey",
    }),
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "purchase_receiving_records_location_business_fkey",
    }),
    index("purchase_receiving_records_purchase_idx").on(
      table.businessId,
      table.purchaseId,
    ),
    index("purchase_receiving_records_item_idx").on(
      table.businessId,
      table.purchaseItemId,
    ),
  ],
);
