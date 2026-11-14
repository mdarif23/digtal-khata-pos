import {
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { productVariants } from "./productVariants.js";
import { inventoryBatches } from "./inventoryBatches.js";
import { purchaseItems } from "./purchaseItems.js";
import { saleItems } from "./saleItems.js";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";
export const serialStatusEnum = pgEnum("serial_status", [
  "in_stock", // 1. Sitting on the shelf, available to be sold.
  "reserved", // 2. Held for a specific customer order or quote (not available for normal sale).
  "sold", // 3. Sold to a customer and left the store.
  "returned", // 4. Customer brought it back (needs inspection before it can be 'in_stock' again).
  "in_repair", // 5. Sent to the manufacturer or IT department for fixing.
  "in_transit", // 6. On a stock transfer between locations (migration 0079).
  "damaged", // 7. Broken, cannot be sold, waiting to be written off.
  "lost", // 8. Missing during stocktake (inventory shrinkage).
]);
export const serialNumbers = pgTable(
  "serial_numbers",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    variantId: integer("variant_id").notNull(),
    batchId: integer("batch_id"),
    serialNumber: varchar("serial_number", { length: 100 }).notNull(),
    status: serialStatusEnum("status").default("in_stock").notNull(),
    purchaseItemId: integer("purchase_item_id"),
    saleItemId: integer("sale_item_id"),
    soldAt: timestamp("sold_at", { withTimezone: true }),
    // Owning outlet for this transaction. Nullable for legacy rows; the
    // application always sets it on new writes. Composite FK guarantees the
    // location belongs to the same business.
    locationId: integer("location_id"),
  },
  (table) => [
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "serial_numbers_location_business_fkey",
    }),
    index("serial_numbers_business_location_idx").on(table.businessId, table.locationId),
    index("serial_numbers_business_id_idx").on(table.businessId),
    // Per-business uniqueness — the same physical serial may legitimately
    // appear in two businesses (e.g. resale). Was globally unique.
    unique("serial_numbers_business_serial_unique").on(
      table.businessId,
      table.serialNumber,
    ),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "serial_numbers_variant_business_fkey",
    }),
    foreignKey({
      columns: [table.batchId, table.businessId],
      foreignColumns: [inventoryBatches.id, inventoryBatches.businessId],
      name: "serial_numbers_batch_business_fkey",
    }),
    foreignKey({
      columns: [table.purchaseItemId, table.businessId],
      foreignColumns: [purchaseItems.id, purchaseItems.businessId],
      name: "serial_numbers_purchase_item_business_fkey",
    }),
    foreignKey({
      columns: [table.saleItemId, table.businessId],
      foreignColumns: [saleItems.id, saleItems.businessId],
      name: "serial_numbers_sale_item_business_fkey",
    }),
  ],
);
