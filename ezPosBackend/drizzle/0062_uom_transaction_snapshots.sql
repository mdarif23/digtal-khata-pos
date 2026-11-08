-- 0062: Multiple Units of Measure (UOM) — transaction snapshots, precision
-- widenings, and package-barcode link (report
-- docs/multiple-uom/phase-0-audit-and-architecture.md §5.2–§5.4).
--
-- STORAGE RULE (the heart of the design): every stored quantity and stored
-- per-unit cost/price column KEEPS today's meaning — BASE units. The unit
-- the user typed lives only in the new nullable snapshot columns, so the
-- DB-generated purchase_items.total, the divide-by-quantity derivations,
-- landed-cost allocation, FIFO, transfers, counts, offline allowances and
-- GL all keep their invariants untouched.
--
-- All columns are nullable; historical rows read back as
-- entered = stored, factor 1 via COALESCE. No existing row is rewritten.
-- Precision widenings are value-preserving (125.00 → 125.000000): they
-- exist so a per-base price derived from a package price (৳1,000 / 3 pcs)
-- never drifts the generated/derived line money.
--
-- PostgreSQL cannot ALTER TYPE a column referenced by a generated column,
-- so the three widenings beneath a generated column (purchase_items.unit_cost,
-- inventory_batches.purchase_price, purchase_return_items.unit_price) drop
-- and recreate the generated column with the IDENTICAL expression — the
-- column order changes, nothing else: no view or trigger references these
-- columns, and all repo queries use named columns.

-- ---------------------------------------------------------------- snapshots
ALTER TABLE "purchase_items"
  ADD COLUMN "uom_conversion_id" integer,
  ADD COLUMN "entered_quantity" numeric(12, 3),
  ADD COLUMN "entered_unit_price" numeric(14, 6),
  ADD COLUMN "conversion_factor" numeric(14, 6);

ALTER TABLE "sale_items"
  ADD COLUMN "uom_conversion_id" integer,
  ADD COLUMN "entered_quantity" numeric(12, 3),
  ADD COLUMN "entered_unit_price" numeric(14, 6),
  ADD COLUMN "conversion_factor" numeric(14, 6);

-- Per-delivery audit rows snapshot what the operator typed at the session.
ALTER TABLE "purchase_receiving_records"
  ADD COLUMN "uom_conversion_id" integer,
  ADD COLUMN "entered_quantity" numeric(12, 3),
  ADD COLUMN "entered_unit_price" numeric(14, 6),
  ADD COLUMN "conversion_factor" numeric(14, 6);

-- Purchase returns may be entered in the original purchase unit or an
-- authorized equivalent; base quantity stays in "quantity".
ALTER TABLE "purchase_return_items"
  ADD COLUMN "uom_conversion_id" integer,
  ADD COLUMN "entered_quantity" numeric(12, 3),
  ADD COLUMN "entered_unit_price" numeric(14, 6),
  ADD COLUMN "conversion_factor" numeric(14, 6);

-- A package barcode is an alias that carries WHICH packaging it resolves
-- to. NULL (every existing row) = base unit — existing behavior unchanged.
ALTER TABLE "variant_barcode_aliases"
  ADD COLUMN "uom_conversion_id" integer;

-- A UOM line must carry its factor snapshot (historical transactions are
-- never re-derived from current settings).
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_uom_factor_check"
  CHECK ("uom_conversion_id" IS NULL OR ("conversion_factor" IS NOT NULL AND "conversion_factor" > (0)::numeric));
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_uom_factor_check"
  CHECK ("uom_conversion_id" IS NULL OR ("conversion_factor" IS NOT NULL AND "conversion_factor" > (0)::numeric));
ALTER TABLE "purchase_receiving_records" ADD CONSTRAINT "prr_uom_factor_check"
  CHECK ("uom_conversion_id" IS NULL OR ("conversion_factor" IS NOT NULL AND "conversion_factor" > (0)::numeric));
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "pri_uom_factor_check"
  CHECK ("uom_conversion_id" IS NULL OR ("conversion_factor" IS NOT NULL AND "conversion_factor" > (0)::numeric));

-- ------------------------------------------------------- precision widenings
ALTER TABLE "sale_items" ALTER COLUMN "selling_price" TYPE numeric(14, 6);
ALTER TABLE "sale_items" ALTER COLUMN "cost_at_sale" TYPE numeric(14, 6);

-- purchase_items.total is GENERATED from unit_cost: drop → widen → recreate
-- with the identical expression (0000_fine_shadow_king.sql:220).
ALTER TABLE "purchase_items" DROP COLUMN "total";
ALTER TABLE "purchase_items" ALTER COLUMN "unit_cost" TYPE numeric(14, 6);
ALTER TABLE "purchase_items"
  ADD COLUMN "total" numeric(12, 2)
  GENERATED ALWAYS AS (( (quantity * unit_cost) - discount + tax )) STORED NOT NULL;

-- inventory_batches.landed_cost_per_unit is GENERATED from purchase_price
-- (0044_spotty_roulette.sql:126): same drop → widen → recreate.
ALTER TABLE "inventory_batches" DROP COLUMN "landed_cost_per_unit";
ALTER TABLE "inventory_batches" ALTER COLUMN "purchase_price" TYPE numeric(14, 6);
ALTER TABLE "inventory_batches"
  ADD COLUMN "landed_cost_per_unit" numeric(14, 6)
  GENERATED ALWAYS AS (( (purchase_price + coalesce(additional_cost_per_unit, 0)) )) STORED NOT NULL;

-- purchase_return_items.line_total is GENERATED from unit_price
-- (0000_fine_shadow_king.sql:239): same drop → widen → recreate.
ALTER TABLE "purchase_return_items" DROP COLUMN "line_total";
ALTER TABLE "purchase_return_items" ALTER COLUMN "unit_price" TYPE numeric(14, 6);
ALTER TABLE "purchase_return_items"
  ADD COLUMN "line_total" numeric(12, 2)
  GENERATED ALWAYS AS ((quantity * unit_price)) STORED;

-- ------------------------------------------------------------ FK wiring
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_uom_business_fkey"
  FOREIGN KEY ("uom_conversion_id", "business_id")
  REFERENCES "product_unit_conversions" ("id", "business_id") ON DELETE NO ACTION;
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_uom_business_fkey"
  FOREIGN KEY ("uom_conversion_id", "business_id")
  REFERENCES "product_unit_conversions" ("id", "business_id") ON DELETE NO ACTION;
ALTER TABLE "purchase_receiving_records" ADD CONSTRAINT "prr_uom_business_fkey"
  FOREIGN KEY ("uom_conversion_id", "business_id")
  REFERENCES "product_unit_conversions" ("id", "business_id") ON DELETE NO ACTION;
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "pri_uom_business_fkey"
  FOREIGN KEY ("uom_conversion_id", "business_id")
  REFERENCES "product_unit_conversions" ("id", "business_id") ON DELETE NO ACTION;
ALTER TABLE "variant_barcode_aliases" ADD CONSTRAINT "vba_uom_business_fkey"
  FOREIGN KEY ("uom_conversion_id", "business_id")
  REFERENCES "product_unit_conversions" ("id", "business_id") ON DELETE NO ACTION;
