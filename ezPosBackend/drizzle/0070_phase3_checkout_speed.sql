-- 0070: Phase 3 — Checkout speed & promotions (approved audit report §5,
-- advanced-POS master prompt Features 1, 2, 8).
--
-- GOVERNING PRINCIPLES:
-- 1. Speed-key tiles and CFD pairing/display rows are business-scoped and
--    reference EXISTING product/variant records — tiles never duplicate
--    products (master prompt F2).
-- 2. CFD pairing follows the PROVEN terminal pattern: one-time 8-char code,
--    SHA-256-hashed, 10-minute TTL, secret shown once, revocable. The
--    display stream is READ-ONLY — no endpoint can create or modify sales
--    with a display token.
-- 3. Promotion extensions are ADDITIVE: promo_kind defaults to 'discount'
--    (existing rows keep behaving exactly as before); new rule shapes live
--    in a jsonb column validated by the engine. Usage counting is
--    idempotent per sale via a unique constraint.
-- 4. Rollback = DROP the four new tables + the new columns.

-- ---------------------------------------------------------------------------
-- 1. Promotions engine extensions (Feature 8).
-- ---------------------------------------------------------------------------
ALTER TABLE "pricing_promotions" ADD COLUMN IF NOT EXISTS "promo_kind" varchar(20) NOT NULL DEFAULT 'discount';
--> statement-breakpoint
ALTER TABLE "pricing_promotions" DROP CONSTRAINT IF EXISTS "pricing_promotions_kind_check";
--> statement-breakpoint
ALTER TABLE "pricing_promotions" ADD CONSTRAINT "pricing_promotions_kind_check" CHECK ("promo_kind" IN ('discount', 'bogo', 'buy_x_get_y', 'mix_match', 'quantity_tier'));
--> statement-breakpoint
-- Kind-specific configuration: BOGO {buyQty,getQty}, buy_x_get_y
-- {buyVariantId|buyProductId, buyQty, getVariantId|getProductId, getQty,
-- getDiscountPercent}, mix_match {comboSize, discountPercent},
-- quantity_tier {tiers:[{minQty, discountPercent}]}.
ALTER TABLE "pricing_promotions" ADD COLUMN IF NOT EXISTS "rule" jsonb;
--> statement-breakpoint
-- Flash-sale windows: day-of-week (0=Sunday .. 6=Saturday) + time-of-day
-- evaluated in Asia/Dhaka (fixed UTC+6, no DST) against the SERVER clock.
ALTER TABLE "pricing_promotions" ADD COLUMN IF NOT EXISTS "days_of_week" jsonb;
--> statement-breakpoint
ALTER TABLE "pricing_promotions" ADD COLUMN IF NOT EXISTS "start_time" varchar(5);
--> statement-breakpoint
ALTER TABLE "pricing_promotions" ADD COLUMN IF NOT EXISTS "end_time" varchar(5);
--> statement-breakpoint
-- Location scope: NULL = every location of the business.
ALTER TABLE "pricing_promotions" ADD COLUMN IF NOT EXISTS "location_id" integer;
--> statement-breakpoint
ALTER TABLE "pricing_promotions" ADD COLUMN IF NOT EXISTS "usage_limit" integer;
--> statement-breakpoint
ALTER TABLE "pricing_promotions" ADD COLUMN IF NOT EXISTS "per_customer_limit" integer;
--> statement-breakpoint
ALTER TABLE "pricing_promotions" ADD COLUMN IF NOT EXISTS "priority" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pricing_promotions_business_active_idx"
  ON "pricing_promotions" ("business_id", "promo_kind")
  WHERE "is_active" = true;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "promotion_usage" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "promotion_id" integer NOT NULL,
  "sale_id" integer NOT NULL,
  "customer_id" integer,
  "used_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "promotion_usage_sale_promo_uq" UNIQUE ("business_id", "sale_id", "promotion_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_usage_promo_idx" ON "promotion_usage" ("business_id", "promotion_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_usage_customer_idx" ON "promotion_usage" ("business_id", "customer_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Speed keys / visual product grid (Feature 2).
--    scope_type: business (scope_id 0) | user (scope_id = user id) |
--    register (scope_id = register id). Resolution order: user > register >
--    business. Tiles: [{ variantId, label, color, sortOrder }].
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "speed_key_layouts" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "scope_type" varchar(10) NOT NULL,
  "scope_id" integer NOT NULL DEFAULT 0,
  "tiles" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_by" integer REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "speed_key_layouts_scope_check" CHECK ("scope_type" IN ('business', 'user', 'register')),
  CONSTRAINT "speed_key_layouts_scope_uq" UNIQUE ("business_id", "scope_type", "scope_id")
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Customer-facing display (Feature 1): pairing + displays + idle copy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "cfd_pairings" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "code_hash" varchar(64) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_by" integer NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cfd_pairings_code_idx" ON "cfd_pairings" ("code_hash");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cfd_displays" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "name" varchar(80) NOT NULL,
  "token_hash" varchar(64) NOT NULL,
  "status" varchar(10) NOT NULL DEFAULT 'active',
  "last_seen_at" timestamp with time zone,
  -- Last pushed cart snapshot so a reconnecting display restores instantly.
  "last_payload" jsonb,
  "payload_updated_at" timestamp with time zone,
  "created_by" integer NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cfd_displays_status_check" CHECK ("status" IN ('active', 'revoked')),
  CONSTRAINT "cfd_displays_token_uq" UNIQUE ("token_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cfd_displays_business_idx" ON "cfd_displays" ("business_id", "status");
--> statement-breakpoint

-- Idle/promo copy shown on the customer display when no cart is active.
ALTER TABLE "pos_settings" ADD COLUMN IF NOT EXISTS "cfd_idle_message" varchar(200);
--> statement-breakpoint
ALTER TABLE "pos_settings" ADD COLUMN IF NOT EXISTS "cfd_promo_message" varchar(200);
