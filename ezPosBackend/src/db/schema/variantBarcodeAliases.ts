import { timestamp } from "drizzle-orm/pg-core";
import {
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { productVariants } from "./productVariants.js";
import { productUnitConversions } from "./productUnitConversions.js";
import { users } from "./users.js";

/**
 * Additional scannable barcode aliases for a variant (migration 0044).
 *
 * The PRIMARY barcode stays on product_variants.barcode — the canonical,
 * single source of truth that all existing lookups already read. Aliases
 * are extra codes (old barcodes kept after a regeneration, manufacturer
 * alternates, internal print codes) that must resolve to the same variant.
 *
 * Uniqueness is per business, mirroring the primary barcode index. The
 * service additionally enforces cross-table uniqueness (a code cannot be
 * one variant's primary and another variant's alias), so a lookup always
 * resolves deterministically.
 */
export const variantBarcodeAliases = pgTable(
  "variant_barcode_aliases",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    variantId: integer("variant_id").notNull(),
    barcode: varchar("barcode", { length: 100 }).notNull(),
    barcodeFormat: varchar("barcode_format", { length: 20 }),
    /**
     * UOM (migration 0062): when set, this alias is a PACKAGING barcode —
     * scanning it means "one of this conversion unit" (e.g. a box-of-12
     * code), not one base unit. NULL = base unit (all legacy rows).
     */
    uomConversionId: integer("uom_conversion_id"),
    /** external = merchant/manufacturer-supplied; internal = generated. */
    source: varchar("source", { length: 20 }).notNull().default("external"),
    createdBy: integer("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    /** Sync watermark (Phase 2): maintained by trigger. */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("variant_barcode_aliases_business_barcode_uq").on(
      table.businessId,
      table.barcode,
    ),
    unique("variant_barcode_aliases_id_business_uq").on(
      table.id,
      table.businessId,
    ),
    index("variant_barcode_aliases_variant_idx").on(table.variantId),
    index("variant_barcode_aliases_business_idx").on(table.businessId),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "variant_barcode_aliases_variant_business_fkey",
    }),
    foreignKey({
      columns: [table.uomConversionId, table.businessId],
      foreignColumns: [productUnitConversions.id, productUnitConversions.businessId],
      name: "vba_uom_business_fkey",
    }),
  ],
);
