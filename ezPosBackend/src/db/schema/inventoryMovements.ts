import {
  doublePrecision,
  numeric,
  foreignKey,
  index,
  pgTable,
  serial,
  integer,
  varchar,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { productVariants } from "./productVariants.js";
import { locations } from "./locations.js";
import { inventoryBatches } from "./inventoryBatches.js";
import { businesses } from "./businesses.js";

// 1. Create an Enum for Movement Type
export const movementTypeEnum = pgEnum("movement_type", [
  "purchase",      // Stock received from a supplier
  "sale",          // Stock sold to a customer
  "return",        // Stock returned by a customer
  "adjustment",    // Manual stock take correction (+/-)
  "transfer_in",   // Stock moved from another location
  "transfer_out",  // Stock moved to another location
]);

// 2. Create the Table
export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: serial("id").primaryKey(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),

    // Foreign Keys
    variantId: integer("variant_id").notNull(),

    locationId: integer("location_id"),

    // Nullable: Only applies if the product tracks batches
    batchId: integer("batch_id"),

    // Movement Details
    movementType: movementTypeEnum("movement_type").notNull(),

    // Can be positive (in) or negative (out)
    /** Phase 4: float8 — weight movements are fractional. */
    quantity: doublePrecision("quantity").notNull(),

    // Polymorphic Reference (Links to Purchase, Sale, or Adjustment)
    // e.g., referenceType = "purchase", referenceId = 15
    // Polymorphic — cannot carry a foreign key; ownership is enforced by the
    // services that write movements inside an already-scoped transaction.
    referenceType: varchar("reference_type", { length: 50 }).notNull(),
    referenceId: integer("reference_id"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("inventory_movements_business_id_idx").on(table.businessId),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "inventory_movements_variant_business_fkey",
    }).onDelete("restrict"), // Don't delete a variant if it has history!
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "inventory_movements_location_business_fkey",
    }),
    foreignKey({
      columns: [table.batchId, table.businessId],
      foreignColumns: [inventoryBatches.id, inventoryBatches.businessId],
      name: "inventory_movements_batch_business_fkey",
    }),
  ],
);
