-- 0071: Phase 4 — Advanced inventory (approved audit report §5, master
-- prompt Features 9, 10, 14, 17).
--
-- GOVERNING PRINCIPLES:
-- 1. Transfers gain an explicit AUTHORIZE step and receive-time DISCREPANCY
--    recording — both additive columns; existing draft→ship→receive flows
--    keep working (ship auto-authorizes when no authorize call happened, so
--    unattended integrations are unaffected).
-- 2. Composite/BOM: bom_components defines component variants per finished
--    variant; selling a composite deducts components through the SAME
--    inventory movement machinery (no direct stock writes); production runs
--    assemble finished stock from components with full traceability.
--    Circular references are prevented at write time (DFS guard) AND the
--    engine refuses chains deeper than a hard cap.
-- 3. Weight selling: variant-level sold_by_weight flag; quantities for such
--    variants accept decimals end-to-end (offline allocations stay integer
--    and skip weight variants by policy).
-- 4. Embedded price/weight barcodes: per-business config in pos_settings.
-- 5. Rollback documented per section.

-- ---------------------------------------------------------------------------
-- 1. Stock transfers: authorize step + discrepancy + serials (Feature 17).
-- ---------------------------------------------------------------------------
ALTER TABLE "stock_transfers" ADD COLUMN IF NOT EXISTS "authorized_by" integer REFERENCES "users" ("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD COLUMN IF NOT EXISTS "authorized_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD COLUMN IF NOT EXISTS "serial_numbers" jsonb;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "transfer_discrepancies" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "transfer_id" integer NOT NULL,
  "item_id" integer NOT NULL,
  "shipped_qty" integer NOT NULL,
  "received_qty" integer NOT NULL,
  "difference" integer NOT NULL,
  "reason" text,
  "recorded_by" integer NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  FOREIGN KEY ("transfer_id", "business_id")
    REFERENCES "stock_transfers" ("id", "business_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transfer_discrepancies_transfer_idx" ON "transfer_discrepancies" ("transfer_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Composite products / BOM (Feature 9).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "bom_components" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "parent_variant_id" integer NOT NULL,
  "component_variant_id" integer NOT NULL,
  "quantity" numeric(14, 4) NOT NULL,
  "waste_percent" numeric(5, 2) NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bom_components_parent_uq" UNIQUE ("business_id", "parent_variant_id", "component_variant_id"),
  CONSTRAINT "bom_components_values_check" CHECK ("quantity" > 0 AND "waste_percent" >= 0 AND "waste_percent" <= 100),
  FOREIGN KEY ("parent_variant_id", "business_id") REFERENCES "product_variants" ("id", "business_id") ON DELETE CASCADE,
  FOREIGN KEY ("component_variant_id", "business_id") REFERENCES "product_variants" ("id", "business_id") ON DELETE RESTRICT,
  CONSTRAINT "bom_components_not_self_check" CHECK ("parent_variant_id" <> "component_variant_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bom_components_parent_idx" ON "bom_components" ("business_id", "parent_variant_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "production_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "location_id" integer NOT NULL,
  "parent_variant_id" integer NOT NULL,
  "quantity" numeric(14, 4) NOT NULL,
  "status" varchar(12) NOT NULL DEFAULT 'completed',
  "component_cost" numeric(14, 2) NOT NULL DEFAULT 0,
  "notes" text,
  "created_by" integer NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "production_runs_status_check" CHECK ("status" IN ('completed', 'void')),
  CONSTRAINT "production_runs_qty_check" CHECK ("quantity" > 0),
  CONSTRAINT "production_runs_id_business_uq" UNIQUE ("id", "business_id"),
  FOREIGN KEY ("parent_variant_id", "business_id") REFERENCES "product_variants" ("id", "business_id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_runs_business_idx" ON "production_runs" ("business_id", "created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "production_run_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "run_id" integer NOT NULL,
  "component_variant_id" integer NOT NULL,
  "quantity_consumed" numeric(14, 4) NOT NULL,
  "unit_cost" numeric(14, 4) NOT NULL DEFAULT 0,
  FOREIGN KEY ("run_id", "business_id") REFERENCES "production_runs" ("id", "business_id") ON DELETE CASCADE
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Weight-based selling (Feature 10): variant flag + embedded barcode
--    configuration. Offline allocations deliberately skip sold_by_weight
--    variants (their ledger is integer) — enforced in code, documented.
-- ---------------------------------------------------------------------------
ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "sold_by_weight" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "pos_settings" ADD COLUMN IF NOT EXISTS "embedded_barcode" jsonb;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Reorder forecasting (Feature 14): supplier lead times per variant
--    (supplier default via variant's purchase linkage; explicit per-variant
--    override wins).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "supplier_lead_times" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "supplier_id" integer NOT NULL,
  "variant_id" integer NOT NULL,
  "lead_time_days" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "supplier_lead_times_uq" UNIQUE ("business_id", "supplier_id", "variant_id"),
  CONSTRAINT "supplier_lead_times_check" CHECK ("lead_time_days" BETWEEN 0 AND 365),
  FOREIGN KEY ("variant_id", "business_id") REFERENCES "product_variants" ("id", "business_id") ON DELETE CASCADE
);
--> statement-breakpoint
