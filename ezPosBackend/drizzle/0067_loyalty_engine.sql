-- 0067: Loyalty engine completion (Phase 2A — approved audit report §5,
-- advanced-POS master prompt Feature 5).
--
-- GOVERNING PRINCIPLES:
-- 1. The ± ledger stays the single source of truth; balance = SUM(points).
--    New columns enrich rows (entry_type, balance_after, expires_at) without
--    changing the balance semantics. Legacy rows are backfilled once.
-- 2. Expiry is implemented with REDEEMABLE BATCHES: every earn creates a
--    batch (points_original/points_remaining, expires_at NULL = never).
--    Redemption consumes batches FIFO by soonest expiry; the sweep zeroes
--    expired batches and writes 'expiry' ledger rows. No destructive updates
--    to the ledger itself.
-- 3. Tiers are DERIVED from qualifying spend, never manually assigned:
--    customer_loyalty_state tracks lifetime/window spend and the engine
--    re-evaluates the tier transactionally after each earning sale.
-- 4. ADDITIVE ONLY. All statements idempotent; statement-breakpoint markers
--    for scripts/apply-migration.mjs (plpgsql-free file, but markers keep
--    the runner uniform). Rollback = DROP the four new tables + new columns
--    + the loyalty.adjust permission row.

-- ---------------------------------------------------------------------------
-- 1. Program extensions: expiry policy + redemption caps.
-- ---------------------------------------------------------------------------
ALTER TABLE "loyalty_programs" ADD COLUMN IF NOT EXISTS "expiry_mode" varchar(10) NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD COLUMN IF NOT EXISTS "expiry_days" integer;
--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD COLUMN IF NOT EXISTS "min_redemption_points" numeric(12, 2) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD COLUMN IF NOT EXISTS "max_redemption_points_per_sale" numeric(12, 2);
--> statement-breakpoint
ALTER TABLE "loyalty_programs" DROP CONSTRAINT IF EXISTS "loyalty_programs_expiry_mode_check";
--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD CONSTRAINT "loyalty_programs_expiry_mode_check" CHECK ("expiry_mode" IN ('none', 'fixed'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Earning rules — ONE configurable rule set per business (singleton, like
--    the program row). Campaign window + exclusions + minimum spend +
--    multiplier + flat bonus. The engine composes: points = eligibleBase ×
--    earnRate × rule.multiplier × tier.multiplier (+ bonus).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "loyalty_earn_rules" (
  "business_id" integer PRIMARY KEY REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "is_active" boolean NOT NULL DEFAULT true,
  "min_transaction_amount" numeric(12, 2) NOT NULL DEFAULT 0,
  "excluded_category_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "excluded_product_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "bonus_points" numeric(12, 2) NOT NULL DEFAULT 0,
  "multiplier" numeric(6, 3) NOT NULL DEFAULT 1,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "loyalty_earn_rules_multiplier_check" CHECK ("multiplier" >= 0),
  CONSTRAINT "loyalty_earn_rules_amount_check" CHECK ("min_transaction_amount" >= 0 AND "bonus_points" >= 0)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Loyalty tiers — ranked by min_spend; qualification_months narrows the
--    spend window (NULL = lifetime). earn_multiplier compounds the earn
--    calculation. Name unique per business.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "loyalty_tiers" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "name" varchar(60) NOT NULL,
  "min_spend" numeric(14, 2) NOT NULL DEFAULT 0,
  "qualification_months" integer,
  "earn_multiplier" numeric(6, 3) NOT NULL DEFAULT 1,
  "rank" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "loyalty_tiers_business_name_uq" UNIQUE ("business_id", "name"),
  CONSTRAINT "loyalty_tiers_values_check" CHECK ("min_spend" >= 0 AND "earn_multiplier" >= 0 AND ("qualification_months" IS NULL OR "qualification_months" > 0))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loyalty_tiers_business_rank_idx" ON "loyalty_tiers" ("business_id", "rank");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Per-customer loyalty state — tier + lifetime counters, updated in the
--    same transaction as the ledger rows that change them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "customer_loyalty_state" (
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "customer_id" integer NOT NULL REFERENCES "customers" ("id") ON DELETE CASCADE,
  "tier_id" integer REFERENCES "loyalty_tiers" ("id") ON DELETE SET NULL,
  "lifetime_earned" numeric(14, 2) NOT NULL DEFAULT 0,
  "lifetime_redeemed" numeric(14, 2) NOT NULL DEFAULT 0,
  "lifetime_spend" numeric(14, 2) NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("business_id", "customer_id")
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Redeemable point batches — the expiry model (principle 2).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "loyalty_points_batches" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "customer_id" integer NOT NULL REFERENCES "customers" ("id") ON DELETE CASCADE,
  "points_original" numeric(12, 2) NOT NULL,
  "points_remaining" numeric(12, 2) NOT NULL,
  "earned_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  "source_type" varchar(20) NOT NULL DEFAULT 'sale_earn',
  "ledger_id" integer,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "loyalty_points_batches_positive_check" CHECK ("points_original" > 0 AND "points_remaining" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loyalty_points_batches_customer_idx"
  ON "loyalty_points_batches" ("business_id", "customer_id", "expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loyalty_points_batches_expiry_idx"
  ON "loyalty_points_batches" ("expires_at")
  WHERE "points_remaining" > 0 AND "expires_at" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Ledger extensions: entry_type (display semantics), balance_after
--    (auditability), expires_at (when this row's points expire).
--    source_type gains 'expiry' and 'restore' for the sweep/refund paths.
-- ---------------------------------------------------------------------------
ALTER TABLE "loyalty_ledger" ADD COLUMN IF NOT EXISTS "entry_type" varchar(20);
--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD COLUMN IF NOT EXISTS "balance_after" numeric(12, 2);
--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint

-- Backfill entry_type from the legacy source_type (one-time).
UPDATE "loyalty_ledger"
SET "entry_type" = CASE "source_type"
  WHEN 'sale_earn' THEN 'earned'
  WHEN 'redeem' THEN 'redeemed'
  WHEN 'refund_reversal' THEN 'reversed'
  ELSE 'adjusted'
END
WHERE "entry_type" IS NULL;
--> statement-breakpoint

-- Extend the source_type CHECK (constraint name may vary across envs —
-- locate it dynamically). Idempotent: only acts when the value is rejected.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT tc.constraint_name INTO constraint_name
  FROM information_schema.check_constraints cc
  JOIN information_schema.table_constraints tc
    ON tc.constraint_name = cc.constraint_name
   AND tc.table_schema = cc.constraint_schema
  WHERE cc.check_clause LIKE '%sale_earn%'
    AND tc.table_name = 'loyalty_ledger'
    AND tc.constraint_type = 'CHECK'
  LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    BEGIN
      EXECUTE format('ALTER TABLE "loyalty_ledger" DROP CONSTRAINT %I', constraint_name);
      EXECUTE format(
        'ALTER TABLE "loyalty_ledger" ADD CONSTRAINT %I CHECK ("source_type" IN (''sale_earn'',''redeem'',''refund_reversal'',''manual'',''expiry'',''restore''))',
        constraint_name
      );
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'loyalty_ledger source_type constraint update skipped: %', SQLERRM;
    END;
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "loyalty_ledger_expiry_idx"
  ON "loyalty_ledger" ("business_id", "customer_id", "expires_at");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. RBAC — loyalty.adjust (manual balance corrections are sensitive).
-- ---------------------------------------------------------------------------
INSERT INTO "permissions" ("key", "module", "description")
VALUES
  ('loyalty.adjust', 'loyalty', 'Manually adjust a customer''s loyalty points (audited, reason required)')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

INSERT INTO
    "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT
    rp.role_id,
    p.id
FROM
    "role_permissions" rp
    JOIN "permissions" p ON p.key = 'loyalty.adjust'
WHERE
    rp.permission_id IN (
      SELECT id FROM "permissions" WHERE key = 'loyalty.manage'
    )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
