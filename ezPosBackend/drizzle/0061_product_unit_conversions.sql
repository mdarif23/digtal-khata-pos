-- 0061: Multiple Units of Measure (UOM) & Packaging Conversion — Phase 1
-- foundation (user-approved master prompt, report
-- docs/multiple-uom/phase-0-audit-and-architecture.md §5.1).
--
-- One authoritative packaging row per (product, variant-scope, unit):
--   conversion_factor = how many BASE units one of this unit contains
--   (1 Box = 12 Pieces → factor 12). Direct-to-base only; no chains.
--
-- ZERO-TOUCH MIGRATION: the product's existing products.unit_id IS its base
-- unit by definition — every existing quantity column (stock, batches,
-- purchase/sale lines, transfers, counts, movements) is already denominated
-- in that unit, so it already IS base-unit stock. The base unit never gets
-- a conversion row (implicit factor 1, always purchasable/sellable); a
-- product with zero rows here behaves exactly as before this migration.
-- No existing row is read or rewritten.
CREATE TABLE "product_unit_conversions" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL,
  "product_id" integer NOT NULL,
  -- NULL = product-level default packaging; set = variant-specific override
  -- (e.g. Football Small 12/box, Medium 10/box, Large 6/box).
  "variant_id" integer,
  "unit_id" integer NOT NULL,
  "conversion_factor" numeric(14, 6) NOT NULL,
  "is_purchase_enabled" boolean DEFAULT true NOT NULL,
  "is_sale_enabled" boolean DEFAULT true NOT NULL,
  "is_default_purchase" boolean DEFAULT false NOT NULL,
  "is_default_sale" boolean DEFAULT false NOT NULL,
  -- Default prices PER THIS UNIT for prefill/display only; NULL sale_price
  -- derives as factor × variant.selling_price. Actual transaction prices are
  -- always captured per line (configured default ≠ transaction price).
  "sale_price" numeric(14, 2),
  "purchase_price" numeric(14, 2),
  "status" varchar(20) DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "puc_factor_positive_check" CHECK ("conversion_factor" > (0)::numeric),
  CONSTRAINT "puc_status_check" CHECK ("status" IN ('active', 'inactive'))
);

-- Tenant-safe composite FKs (repo pattern: unique (id, business_id) on the
-- target lets referencing FKs enforce tenancy, not just identity).
CREATE UNIQUE INDEX "puc_id_business_uq"
  ON "product_unit_conversions" ("id", "business_id");
CREATE UNIQUE INDEX "units_id_business_uq" ON "units" ("id", "business_id");

ALTER TABLE "product_unit_conversions" ADD CONSTRAINT "puc_product_business_fkey"
  FOREIGN KEY ("product_id", "business_id")
  REFERENCES "products" ("id", "business_id") ON DELETE NO ACTION;
ALTER TABLE "product_unit_conversions" ADD CONSTRAINT "puc_variant_business_fkey"
  FOREIGN KEY ("variant_id", "business_id")
  REFERENCES "product_variants" ("id", "business_id") ON DELETE NO ACTION;
ALTER TABLE "product_unit_conversions" ADD CONSTRAINT "puc_unit_business_fkey"
  FOREIGN KEY ("unit_id", "business_id")
  REFERENCES "units" ("id", "business_id") ON DELETE NO ACTION;

-- One row per (product, variant-scope, unit): a unit cannot be configured
-- twice at the same scope (COALESCE collapses NULL variant scope to 0).
CREATE UNIQUE INDEX "puc_product_unit_uq"
  ON "product_unit_conversions" (
    "product_id", COALESCE("variant_id", 0), "unit_id"
  );

-- At most one default purchase/sale unit per scope (partial indexes so
-- inactive rows never block a new default).
CREATE UNIQUE INDEX "puc_default_sale_uq"
  ON "product_unit_conversions" ("product_id", COALESCE("variant_id", 0))
  WHERE "is_default_sale" AND "status" = 'active';
CREATE UNIQUE INDEX "puc_default_purchase_uq"
  ON "product_unit_conversions" ("product_id", COALESCE("variant_id", 0))
  WHERE "is_default_purchase" AND "status" = 'active';

CREATE INDEX "puc_business_idx" ON "product_unit_conversions" ("business_id");
CREATE INDEX "puc_product_idx" ON "product_unit_conversions" ("product_id");
CREATE INDEX "puc_variant_idx" ON "product_unit_conversions" ("variant_id");
