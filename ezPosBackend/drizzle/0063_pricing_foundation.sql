-- 0063: Percentage-Based Pricing Management — Phase 1 foundation (user-approved
-- master prompt, report docs/percentage-pricing/phase-0-audit-and-architecture.md §13).
--
-- GOVERNING PRINCIPLE (§0 of the report): pricing RULES are configuration only —
-- they say how to CALCULATE a price. product_variants.selling_price stays the
-- single effective price POS/storefront charge. Rules materialize into it only
-- through explicit apply / approved proposal / bulk / opt-in auto-update, and
-- every such write appends product_price_history. Previews never persist.
--
-- ADDITIVE ONLY: every change is a new table or a nullable/defaulted column.
-- No existing column is altered or backfilled; with zero rows everywhere the
-- system behaves exactly as before (zero-touch, same contract as 0061/0062).
-- Rollback = DROP TABLE / DROP COLUMN.

-- ---------------------------------------------------------------------------
-- pricing_settings — singleton per business (posSettings pattern). Absent row
-- = all defaults: fixed pricing (no auto-calculation), no rounding, no floor.
-- ---------------------------------------------------------------------------
CREATE TABLE "pricing_settings" (
  "business_id" integer PRIMARY KEY NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  -- Business-wide default pricing method used when no scoped rule applies.
  "default_method" varchar(20) DEFAULT 'fixed' NOT NULL,
  -- Percent for markup/margin defaults; NULL (required) when method = fixed.
  "default_percentage" numeric(6, 3),
  -- Final-stage price rounding: none | nearest 0.01 | nearest 1 | 5 | 10.
  "rounding_increment" varchar(10) DEFAULT 'none' NOT NULL,
  -- nearest | up (always round up) | down (always round down).
  "rounding_direction" varchar(10) DEFAULT 'nearest' NOT NULL,
  -- Mode B: automatic price updates (opt-in; proposals mode is the default).
  "auto_update_enabled" boolean DEFAULT false NOT NULL,
  -- Never overwrite manually-managed fixed prices unless explicitly enabled.
  "auto_update_fixed_prices" boolean DEFAULT false NOT NULL,
  -- Business-wide minimum margin floor (percent of selling price); NULL = off.
  "min_margin_percent" numeric(5, 2),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pricing_settings_method_check" CHECK (
    ("default_method" = 'fixed' AND "default_percentage" IS NULL)
    OR ("default_method" = 'markup' AND "default_percentage" IS NOT NULL AND "default_percentage" >= 0)
    OR ("default_method" = 'margin' AND "default_percentage" IS NOT NULL AND "default_percentage" >= 0 AND "default_percentage" < 100)
  ),
  CONSTRAINT "pricing_settings_method_valid_check" CHECK ("default_method" IN ('fixed', 'markup', 'margin')),
  CONSTRAINT "pricing_settings_rounding_increment_check" CHECK ("rounding_increment" IN ('none', '0.01', '1', '5', '10')),
  CONSTRAINT "pricing_settings_rounding_direction_check" CHECK ("rounding_direction" IN ('nearest', 'up', 'down')),
  CONSTRAINT "pricing_settings_min_margin_check" CHECK ("min_margin_percent" IS NULL OR ("min_margin_percent" >= 0 AND "min_margin_percent" <= 100))
);

-- ---------------------------------------------------------------------------
-- pricing_rules — the scope hierarchy. Exactly one scope level per row
-- (all NULL = business-wide global). Resolution order: variant > product >
-- nearest category ancestor > global; first ACTIVE hit wins. Ambiguity is
-- made IMPOSSIBLE by partial unique indexes (one active rule per scope).
-- ---------------------------------------------------------------------------
CREATE TABLE "pricing_rules" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  -- Exactly one of these is non-NULL (or all NULL for the global rule).
  "category_id" integer,
  "product_id" integer,
  "variant_id" integer,
  "method" varchar(20) NOT NULL,
  -- Percent (3dp) for markup/margin; REQUIRED NULL for fixed.
  "percentage" numeric(6, 3),
  -- Explicit fixed selling price; REQUIRED NULL for markup/margin.
  "fixed_price" numeric(12, 2),
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pricing_rules_scope_check" CHECK (
    ("category_id" IS NOT NULL AND "product_id" IS NULL AND "variant_id" IS NULL)
    OR ("category_id" IS NULL AND "product_id" IS NOT NULL AND "variant_id" IS NULL)
    OR ("category_id" IS NULL AND "product_id" IS NULL AND "variant_id" IS NOT NULL)
    OR ("category_id" IS NULL AND "product_id" IS NULL AND "variant_id" IS NULL)
  ),
  -- Markup and margin are DIFFERENT (master prompt §5.2): margin >= 100 is a
  -- division by zero and is rejected at the database level, not just the API.
  CONSTRAINT "pricing_rules_method_check" CHECK (
    ("method" = 'fixed' AND "fixed_price" IS NOT NULL AND "percentage" IS NULL AND "fixed_price" >= 0)
    OR ("method" = 'markup' AND "fixed_price" IS NULL AND "percentage" IS NOT NULL AND "percentage" >= 0)
    OR ("method" = 'margin' AND "fixed_price" IS NULL AND "percentage" IS NOT NULL AND "percentage" >= 0 AND "percentage" < 100)
  ),
  CONSTRAINT "pricing_rules_method_valid_check" CHECK ("method" IN ('fixed', 'markup', 'margin'))
);

CREATE UNIQUE INDEX "pricing_rules_id_business_uq" ON "pricing_rules" ("id", "business_id");
CREATE INDEX "pricing_rules_business_idx" ON "pricing_rules" ("business_id");
-- Deterministic precedence: at most ONE active rule per scope level.
CREATE UNIQUE INDEX "uq_pricing_rule_global" ON "pricing_rules" ("business_id")
  WHERE "is_active" AND "category_id" IS NULL AND "product_id" IS NULL AND "variant_id" IS NULL;
CREATE UNIQUE INDEX "uq_pricing_rule_category" ON "pricing_rules" ("business_id", "category_id")
  WHERE "is_active" AND "product_id" IS NULL AND "variant_id" IS NULL;
CREATE UNIQUE INDEX "uq_pricing_rule_product" ON "pricing_rules" ("business_id", "product_id")
  WHERE "is_active" AND "variant_id" IS NULL;
CREATE UNIQUE INDEX "uq_pricing_rule_variant" ON "pricing_rules" ("business_id", "variant_id")
  WHERE "is_active";

-- Candidate keys for the composite tenant FKs below (repo pattern: see
-- products_id_business_uq / units_id_business_uq / puc_id_business_uq).
CREATE UNIQUE INDEX IF NOT EXISTS "categories_id_business_uq" ON "categories" ("id", "business_id");

ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_category_business_fkey"
  FOREIGN KEY ("category_id", "business_id") REFERENCES "categories" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_product_business_fkey"
  FOREIGN KEY ("product_id", "business_id") REFERENCES "products" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_variant_business_fkey"
  FOREIGN KEY ("variant_id", "business_id") REFERENCES "product_variants" ("id", "business_id") ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- customer_groups + membership + group pricing (report §13.3-13.5).
-- Groups are created lazily — NO data backfill in this migration.
-- ---------------------------------------------------------------------------
CREATE TABLE "customer_groups" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "name" varchar(80) NOT NULL,
  "description" text,
  -- At most one default ("General") group per business.
  "is_default" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_groups_business_name_unique" UNIQUE ("business_id", "name")
);
CREATE UNIQUE INDEX "customer_groups_id_business_uq" ON "customer_groups" ("id", "business_id");
CREATE UNIQUE INDEX "uq_customer_groups_default" ON "customer_groups" ("business_id")
  WHERE "is_default";
CREATE INDEX "customer_groups_business_idx" ON "customer_groups" ("business_id");

-- Membership is a live reference (a customer's CURRENT group), not history —
-- group discounts are snapshotted onto sale lines at transaction time.
-- Plain FK (no composite): a composite FK with ON DELETE SET NULL would also
-- NULL the customer's business_id (PostgreSQL nulls every FK column), so the
-- group reference follows the patchProduct precedent — plain FK + the service
-- verifies the group belongs to the caller's business on every write.
ALTER TABLE "customers" ADD COLUMN "customer_group_id" integer;
ALTER TABLE "customers" ADD CONSTRAINT "customers_customer_group_fkey"
  FOREIGN KEY ("customer_group_id") REFERENCES "customer_groups" ("id") ON DELETE SET NULL;
CREATE INDEX "customers_customer_group_idx" ON "customers" ("customer_group_id");

-- Group pricing rules: whole-cart (all scope ids NULL) or product/category/
-- variant scoped (XOR), applied to eligible selling prices only.
CREATE TABLE "customer_group_pricing" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "group_id" integer NOT NULL,
  -- Exactly one scope or all NULL (whole-cart discount).
  "category_id" integer,
  "product_id" integer,
  "variant_id" integer,
  "discount_type" varchar(20) NOT NULL,
  "discount_value" numeric(12, 2) NOT NULL,
  "min_purchase_amount" numeric(12, 2) DEFAULT 0 NOT NULL,
  "min_quantity" integer,
  -- Cap on the computed discount; NULL = uncapped beyond the base itself.
  "max_discount_amount" numeric(12, 2),
  "valid_from" date,
  "valid_to" date,
  -- Explicit stacking policy (master prompt §6): promotions stack only where
  -- permitted. Manual discounts and coupons follow the existing checkout rules.
  "stacks_with_promotions" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cgp_scope_check" CHECK (
    ("category_id" IS NOT NULL AND "product_id" IS NULL AND "variant_id" IS NULL)
    OR ("category_id" IS NULL AND "product_id" IS NOT NULL AND "variant_id" IS NULL)
    OR ("category_id" IS NULL AND "product_id" IS NULL AND "variant_id" IS NOT NULL)
    OR ("category_id" IS NULL AND "product_id" IS NULL AND "variant_id" IS NULL)
  ),
  CONSTRAINT "cgp_type_check" CHECK ("discount_type" IN ('percentage', 'fixed')),
  CONSTRAINT "cgp_value_check" CHECK ("discount_value" >= 0),
  CONSTRAINT "cgp_percentage_cap_check" CHECK ("discount_type" <> 'percentage' OR "discount_value" <= 100),
  CONSTRAINT "cgp_dates_check" CHECK ("valid_from" IS NULL OR "valid_to" IS NULL OR "valid_from" <= "valid_to")
);
CREATE UNIQUE INDEX "cgp_id_business_uq" ON "customer_group_pricing" ("id", "business_id");
CREATE INDEX "cgp_business_group_idx" ON "customer_group_pricing" ("business_id", "group_id");
ALTER TABLE "customer_group_pricing" ADD CONSTRAINT "cgp_group_business_fkey"
  FOREIGN KEY ("group_id", "business_id") REFERENCES "customer_groups" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "customer_group_pricing" ADD CONSTRAINT "cgp_category_business_fkey"
  FOREIGN KEY ("category_id", "business_id") REFERENCES "categories" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "customer_group_pricing" ADD CONSTRAINT "cgp_product_business_fkey"
  FOREIGN KEY ("product_id", "business_id") REFERENCES "products" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "customer_group_pricing" ADD CONSTRAINT "cgp_variant_business_fkey"
  FOREIGN KEY ("variant_id", "business_id") REFERENCES "product_variants" ("id", "business_id") ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- pricing_promotions — AUTO-APPLIED promotions (report §13.6). Coupons remain
-- untouched (code-based, usage-limited); promotions add product/category/
-- variant scoping, quantity/order minimums, group eligibility and explicit
-- stacking configuration. Evaluation is server-side only, shared by quote
-- and createSale (the coupons engine pattern).
-- ---------------------------------------------------------------------------
CREATE TABLE "pricing_promotions" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "name" varchar(120) NOT NULL,
  -- Exactly one scope or all NULL (cart-wide promotion).
  "category_id" integer,
  "product_id" integer,
  "variant_id" integer,
  "discount_type" varchar(20) NOT NULL,
  "discount_value" numeric(12, 2) NOT NULL,
  -- Server-validated validity window (expired promotions never apply).
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "min_quantity" integer,
  "min_order_value" numeric(12, 2) DEFAULT 0 NOT NULL,
  "max_discount_amount" numeric(12, 2),
  "can_stack_with_group_discount" boolean DEFAULT false NOT NULL,
  "can_stack_with_coupons" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "promo_scope_check" CHECK (
    ("category_id" IS NOT NULL AND "product_id" IS NULL AND "variant_id" IS NULL)
    OR ("category_id" IS NULL AND "product_id" IS NOT NULL AND "variant_id" IS NULL)
    OR ("category_id" IS NULL AND "product_id" IS NULL AND "variant_id" IS NOT NULL)
    OR ("category_id" IS NULL AND "product_id" IS NULL AND "variant_id" IS NULL)
  ),
  CONSTRAINT "promo_type_check" CHECK ("discount_type" IN ('percentage', 'fixed')),
  CONSTRAINT "promo_value_check" CHECK ("discount_value" >= 0),
  CONSTRAINT "promo_percentage_cap_check" CHECK ("discount_type" <> 'percentage' OR "discount_value" <= 100),
  CONSTRAINT "promo_dates_check" CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "starts_at" <= "ends_at")
);
CREATE UNIQUE INDEX "pricing_promotions_id_business_uq" ON "pricing_promotions" ("id", "business_id");
CREATE INDEX "pricing_promotions_business_idx" ON "pricing_promotions" ("business_id");
ALTER TABLE "pricing_promotions" ADD CONSTRAINT "promo_category_business_fkey"
  FOREIGN KEY ("category_id", "business_id") REFERENCES "categories" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "pricing_promotions" ADD CONSTRAINT "promo_product_business_fkey"
  FOREIGN KEY ("product_id", "business_id") REFERENCES "products" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "pricing_promotions" ADD CONSTRAINT "promo_variant_business_fkey"
  FOREIGN KEY ("variant_id", "business_id") REFERENCES "product_variants" ("id", "business_id") ON DELETE CASCADE;

-- Group eligibility: NO rows = eligible for every customer; rows = listed
-- groups only (whole-cart and scoped promotions both).
CREATE TABLE "promotion_customer_groups" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "promotion_id" integer NOT NULL,
  "group_id" integer NOT NULL,
  CONSTRAINT "promo_group_unique" UNIQUE ("promotion_id", "group_id")
);
CREATE INDEX "promo_group_promotion_idx" ON "promotion_customer_groups" ("promotion_id");
ALTER TABLE "promotion_customer_groups" ADD CONSTRAINT "promo_group_promotion_fkey"
  FOREIGN KEY ("promotion_id", "business_id") REFERENCES "pricing_promotions" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "promotion_customer_groups" ADD CONSTRAINT "promo_group_group_fkey"
  FOREIGN KEY ("group_id", "business_id") REFERENCES "customer_groups" ("id", "business_id") ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- price_change_proposals — Mode A (manual approval, the DEFAULT update mode).
-- One sweep run groups its proposals under batch_token; stale marks proposals
-- whose cost/price moved after generation.
-- ---------------------------------------------------------------------------
CREATE TABLE "price_change_proposals" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "variant_id" integer NOT NULL,
  "batch_token" varchar(64) NOT NULL,
  "old_cost" numeric(14, 6),
  "new_cost" numeric(14, 6),
  "old_price" numeric(12, 2),
  "recommended_price" numeric(12, 2) NOT NULL,
  "percent_change" numeric(6, 2),
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "rule_id" integer,
  "decided_by" integer REFERENCES "users" ("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pcp_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'applied', 'stale'))
);
CREATE INDEX "pcp_business_status_idx" ON "price_change_proposals" ("business_id", "status");
CREATE INDEX "pcp_business_batch_idx" ON "price_change_proposals" ("business_id", "batch_token");
ALTER TABLE "price_change_proposals" ADD CONSTRAINT "pcp_variant_business_fkey"
  FOREIGN KEY ("variant_id", "business_id") REFERENCES "product_variants" ("id", "business_id") ON DELETE CASCADE;
-- Plain FKs with SET NULL: history/proposals must survive rule deletion with
-- their audit content intact (and a composite FK would also NULL business_id).
ALTER TABLE "price_change_proposals" ADD CONSTRAINT "pcp_rule_fkey"
  FOREIGN KEY ("rule_id") REFERENCES "pricing_rules" ("id") ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- product_price_history — every materialized change to
-- product_variants.selling_price. NEVER updated or deleted; audit trail for
-- reports and rollback analysis.
-- ---------------------------------------------------------------------------
CREATE TABLE "product_price_history" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "variant_id" integer NOT NULL,
  "old_price" numeric(12, 2),
  "new_price" numeric(12, 2) NOT NULL,
  -- manual | rule_apply | proposal | auto_update | bulk | import | override
  "source" varchar(20) NOT NULL,
  "rule_id" integer,
  "proposal_id" integer,
  -- Cost context at change time (weighted-avg landed cost), when available.
  "cost_at_change" numeric(14, 6),
  -- Mandatory reason for below-minimum overrides.
  "reason" text,
  "changed_by_user_id" integer REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pph_source_check" CHECK ("source" IN ('manual', 'rule_apply', 'proposal', 'auto_update', 'bulk', 'import', 'override'))
);
CREATE INDEX "pph_business_variant_date_idx" ON "product_price_history" ("business_id", "variant_id", "created_at");
ALTER TABLE "product_price_history" ADD CONSTRAINT "pph_variant_business_fkey"
  FOREIGN KEY ("variant_id", "business_id") REFERENCES "product_variants" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "product_price_history" ADD CONSTRAINT "pph_rule_fkey"
  FOREIGN KEY ("rule_id") REFERENCES "pricing_rules" ("id") ON DELETE SET NULL;
ALTER TABLE "product_price_history" ADD CONSTRAINT "pph_proposal_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES "price_change_proposals" ("id") ON DELETE SET NULL;
ALTER TABLE "product_price_history" ADD CONSTRAINT "pph_user_fkey"
  FOREIGN KEY ("changed_by_user_id") REFERENCES "users" ("id") ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Sale snapshot extensions (report §13.8): per-line adjustment attribution
-- (group | promotion | manual | coupon, in application order) and the
-- customer group AT SALE TIME for group-profitability reporting. The header
-- sales.discount keeps its existing conflated meaning — these columns add
-- attribution without rewriting any existing semantics.
-- ---------------------------------------------------------------------------
ALTER TABLE "sale_items" ADD COLUMN "price_adjustments" jsonb DEFAULT '[]' NOT NULL;
ALTER TABLE "sales" ADD COLUMN "customer_group_id" integer;
-- Snapshot column, deliberately NO foreign key: deleting a group must never
-- rewrite historical sales.
CREATE INDEX "sales_customer_group_idx" ON "sales" ("customer_group_id");

-- ---------------------------------------------------------------------------
-- Minimum-price protection (report §13.10): per-variant floor beside the
-- price it protects. NULL = no explicit floor (business margin floor still
-- applies when configured in pricing_settings.min_margin_percent).
-- ---------------------------------------------------------------------------
ALTER TABLE "product_variants" ADD COLUMN "min_selling_price" numeric(12, 2);

-- ---------------------------------------------------------------------------
-- RBAC: pricing.* keys. ensureRbacSeed (idempotent) inserts the keys at boot,
-- but grants for EXISTING businesses' roles must happen here (0039 precedent:
-- ensureRbacSeed only inserts keys, never grants).
-- Grants mirror the DEFAULT_ROLE_PERMISSIONS presets below:
--   manager + owner (via products.edit): all eight keys.
--   accountant (via reports.profit.view): pricing.view + pricing.history.view.
--   cashier: none.
-- ---------------------------------------------------------------------------
INSERT INTO
    "permissions" ("key", "module", "description")
VALUES
    ('pricing.view', 'pricing', 'View pricing settings, rules and price previews'),
    ('pricing.manage', 'pricing', 'Manage pricing settings and pricing rules'),
    ('pricing.product.manage', 'pricing', 'Set product/variant pricing overrides and apply price changes'),
    ('pricing.customer_groups.manage', 'pricing', 'Manage customer groups and group pricing'),
    ('pricing.price_override', 'pricing', 'Override unit prices at the point of sale'),
    ('pricing.below_minimum_override', 'pricing', 'Approve sales below the minimum price'),
    ('pricing.history.view', 'pricing', 'View price change history and proposals'),
    ('pricing.bulk_update', 'pricing', 'Perform bulk price updates')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO
    "role_permissions" ("role_id", "permission_id")
SELECT
    rp.role_id,
    p.id
FROM
    "role_permissions" rp
    JOIN "permissions" edit ON edit.key = 'products.edit'
    JOIN "permissions" p ON p.key IN (
        'pricing.view', 'pricing.manage', 'pricing.product.manage',
        'pricing.customer_groups.manage', 'pricing.price_override',
        'pricing.below_minimum_override', 'pricing.history.view', 'pricing.bulk_update'
    )
WHERE
    rp.permission_id = edit.id
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

INSERT INTO
    "role_permissions" ("role_id", "permission_id")
SELECT
    rp.role_id,
    p.id
FROM
    "role_permissions" rp
    JOIN "permissions" profit ON profit.key = 'reports.profit.view'
    JOIN "permissions" p ON p.key IN ('pricing.view', 'pricing.history.view')
WHERE
    rp.permission_id = profit.id
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
