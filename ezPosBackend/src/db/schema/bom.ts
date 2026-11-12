import { sql } from "drizzle-orm";
import {
  check,
  integer,
  foreignKey,
  index,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { users } from "./users.js";
import { productVariants } from "./productVariants.js";

/**
 * Composite products / BOM (Phase 4 — master prompt Feature 9). Components
 * reference real variants (composite-on-sale deducts them through FIFO);
 * production runs pre-assemble finished stock with traced component cost.
 */
export const bomComponents = pgTable(
  "bom_components",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    parentVariantId: integer("parent_variant_id").notNull(),
    componentVariantId: integer("component_variant_id").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 4, mode: "number" }).notNull(),
    wastePercent: numeric("waste_percent", {
      precision: 5,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("bom_components_parent_uq").on(
      t.businessId,
      t.parentVariantId,
      t.componentVariantId,
    ),
    index("bom_components_parent_idx").on(t.businessId, t.parentVariantId),
    check(
      "bom_components_values_check",
      sql`${t.quantity} > 0 AND ${t.wastePercent} >= 0 AND ${t.wastePercent} <= 100`,
    ),
    check(
      "bom_components_not_self_check",
      sql`${t.parentVariantId} <> ${t.componentVariantId}`,
    ),
    foreignKey({
      columns: [t.parentVariantId, t.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "bom_components_parent_business_fkey",
    }),
    foreignKey({
      columns: [t.componentVariantId, t.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "bom_components_component_business_fkey",
    }),
  ],
);

export const productionRuns = pgTable(
  "production_runs",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    locationId: integer("location_id").notNull(),
    parentVariantId: integer("parent_variant_id").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 4, mode: "number" }).notNull(),
    status: varchar("status", { length: 12 }).notNull().default("completed"),
    componentCost: numeric("component_cost", {
      precision: 14,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    notes: text(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("production_runs_id_business_uq").on(t.id, t.businessId),
    index("production_runs_business_idx").on(t.businessId, t.createdAt),
    check(
      "production_runs_status_check",
      sql`${t.status} IN ('completed', 'void')`,
    ),
    check("production_runs_qty_check", sql`${t.quantity} > 0`),
    foreignKey({
      columns: [t.parentVariantId, t.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "production_runs_parent_business_fkey",
    }),
  ],
);

export const productionRunItems = pgTable(
  "production_run_items",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    runId: integer("run_id").notNull(),
    componentVariantId: integer("component_variant_id").notNull(),
    quantityConsumed: numeric("quantity_consumed", {
      precision: 14,
      scale: 4,
      mode: "number",
    }).notNull(),
    unitCost: numeric("unit_cost", { precision: 14, scale: 4, mode: "number" })
      .notNull()
      .default(0),
  },
  (t) => [
    foreignKey({
      columns: [t.runId, t.businessId],
      foreignColumns: [productionRuns.id, productionRuns.businessId],
      name: "production_run_items_run_business_fkey",
    }),
  ],
);
