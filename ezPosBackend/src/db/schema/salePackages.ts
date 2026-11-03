import {
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { sales } from "./sales.js";
import { businesses } from "./businesses.js";
import { users } from "./users.js";

/**
 * Physical package(s) an online order was packed into. Product shipping &
 * packaging defaults are COPIED here at pack time — editing product
 * defaults never rewrites an already-processed order.
 */
export const salePackages = pgTable(
  "sale_packages",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    saleId: integer("sale_id").notNull(),
    packageNo: integer("package_no").default(1).notNull(),
    packageType: varchar("package_type", { length: 50 }),
    weightKg: numeric("weight_kg", { precision: 10, scale: 3, mode: "number" }),
    lengthCm: numeric("length_cm", { precision: 10, scale: 2, mode: "number" }),
    widthCm: numeric("width_cm", { precision: 10, scale: 2, mode: "number" }),
    heightCm: numeric("height_cm", { precision: 10, scale: 2, mode: "number" }),
    materialsNote: text("materials_note"),
    /** Business-internal packing cost (materials/labour) — profitability input. */
    packingCost: numeric("packing_cost", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).default(0),
    packedByUserId: integer("packed_by_user_id").references(() => users.id),
    packedAt: timestamp("packed_at", { withTimezone: true }),
    notes: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.saleId, table.businessId],
      foreignColumns: [sales.id, sales.businessId],
      name: "sale_packages_sale_business_fkey",
    }),
    unique("sale_packages_sale_no_unique").on(table.saleId, table.packageNo),
    index("sale_packages_business_id_idx").on(table.businessId),
  ],
);
