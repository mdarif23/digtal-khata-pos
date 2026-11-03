-- Smart Procurement foundation: price intelligence, supplier price
-- monitoring, quick price check, and supplier order-value management.
-- All changes are additive — no existing column or row is modified.
-- See SMART_PROCUREMENT_IMPLEMENTATION.md for the design decisions.

-- 1) Market price observations ("Quick Price Check"): manually recorded
--    supplier quotations from wholesale market visits. These are stored
--    separately from actual purchases (purchase_items / purchases remain
--    the ONLY source of real purchase prices) so a quotation can never be
--    represented as a completed purchase.
CREATE TABLE IF NOT EXISTS "price_observations" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL,
  "variant_id" integer NOT NULL,
  "supplier_id" integer NOT NULL,
  "quoted_price" numeric(12, 2) NOT NULL,
  -- Package size the quotation refers to (e.g. 25 for a 25 KG sack).
  -- NULL means the quoted price is already per unit.
  "package_quantity" numeric(12, 3),
  "observation_date" date NOT NULL DEFAULT CURRENT_DATE,
  "notes" text,
  "created_by_user_id" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "price_observations_quoted_price_check" CHECK ("quoted_price" >= 0),
  CONSTRAINT "price_observations_variant_business_fkey" FOREIGN KEY ("variant_id", "business_id") REFERENCES "product_variants"("id", "business_id"),
  CONSTRAINT "price_observations_supplier_business_fkey" FOREIGN KEY ("supplier_id", "business_id") REFERENCES "suppliers"("id", "business_id"),
  CONSTRAINT "price_observations_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE,
  CONSTRAINT "price_observations_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
);
CREATE INDEX IF NOT EXISTS "price_observations_business_variant_date_idx" ON "price_observations" ("business_id", "variant_id", "observation_date" DESC);
CREATE INDEX IF NOT EXISTS "price_observations_business_supplier_idx" ON "price_observations" ("business_id", "supplier_id");

-- 2) Price-increase alert configuration (one row per business). The
--    threshold is the percentage increase over the previous actual
--    purchase price that triggers a price_increase notification.
CREATE TABLE IF NOT EXISTS "price_alert_settings" (
  "business_id" integer PRIMARY KEY,
  "enabled" boolean NOT NULL DEFAULT false,
  "increase_threshold_pct" numeric(5, 2) NOT NULL DEFAULT 10.00,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "price_alert_settings_threshold_check" CHECK ("increase_threshold_pct" > 0),
  CONSTRAINT "price_alert_settings_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE
);

-- 3) Supplier order-value settings. The minimum order value is the
--    supplier's requirement; the target order value is the business's own
--    spending goal per order. The two are independent (never derived from
--    each other). NULL = not configured; the flag lets the owner disable
--    the feature without deleting the values.
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "minimum_order_value" numeric(12, 2);
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "target_order_value" numeric(12, 2);
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "order_settings_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "order_settings_notes" text;

-- 4) Price-history aggregation reads purchase items per variant; the
--    variant foreign key has no supporting index (Postgres does not
--    auto-index foreign keys).
CREATE INDEX IF NOT EXISTS "purchase_items_business_variant_idx" ON "purchase_items" ("business_id", "variant_id");
