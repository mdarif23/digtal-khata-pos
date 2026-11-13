-- 0076: Phase 5 — Sales team & BI (approved audit report §5, master prompt
-- Feature 13).
--
-- GOVERNING PRINCIPLES:
-- 1. Salesperson assignment is a SNAPSHOT on the sale (salesperson_user_id)
--    plus an audit trail — reassignment records who/when, never rewrites.
-- 2. Commission entries are a LEDGER, never a mutable "current commission":
--    each entry is per sale+user+rule (unique), lifecycle moves
--    calculated → pending → approved → payable → paid, and refunds write a
--    REVERSED entry (negative amount) instead of deleting history.
-- 3. Commission is an EXPENSE-liability: unpaid commission is never booked
--    as an expense (master prompt F13-E) — payment posting happens at
--    payroll-time (manual for v1), documented in the report.
-- 4. ADDITIVE ONLY; rollback = DROP the four tables + columns + permissions.

-- ---------------------------------------------------------------------------
-- 1. Salesperson assignment on sales.
-- ---------------------------------------------------------------------------
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "salesperson_user_id" integer REFERENCES "users" ("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "salesperson_assigned_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "salesperson_assigned_by" integer REFERENCES "users" ("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_salesperson_idx" ON "sales" ("business_id", "salesperson_user_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Commission rules — per business, versionless v1 (changes affect future
--    calculations only; entries snapshot their rate at calculation time).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "commission_rules" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "name" varchar(120) NOT NULL,
  /** percentage_of_sales | fixed_per_sale | percentage_of_profit */
  "calc_method" varchar(30) NOT NULL,
  /** percent (0-100) for percentage methods; flat ৳ for fixed_per_sale. */
  "rate" numeric(14, 4) NOT NULL,
  /** Scope: NULL = whole business; category/product narrow eligibility. */
  "category_id" integer,
  "product_id" integer,
  /** NULL = every salesperson; set = only that user. */
  "user_id" integer REFERENCES "users" ("id") ON DELETE SET NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "commission_rules_method_check" CHECK (
    "calc_method" IN ('percentage_of_sales', 'fixed_per_sale', 'percentage_of_profit')
  ),
  CONSTRAINT "commission_rules_rate_check" CHECK ("rate" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_rules_business_idx" ON "commission_rules" ("business_id", "is_active");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Commission entries — the ledger. Refunds write NEGATIVE reversed
--    entries; history is never deleted.
-- ---------------------------------------------------------------------------
CREATE TYPE "commission_entry_status" AS ENUM (
  'calculated', 'pending', 'approved', 'payable', 'paid', 'reversed'
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commission_entries" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "sale_id" integer NOT NULL,
  "salesperson_user_id" integer NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "rule_id" integer NOT NULL,
  "rule_name_snapshot" varchar(120) NOT NULL,
  /** Snapshot of the calculation inputs at entry time. */
  "calc_method" varchar(30) NOT NULL,
  "rate" numeric(14, 4) NOT NULL,
  "base_amount" numeric(14, 2) NOT NULL,
  "amount" numeric(14, 2) NOT NULL,
  "status" "commission_entry_status" NOT NULL DEFAULT 'pending',
  /** Refund linkage: a reversed entry references the refund id. */
  "refund_id" integer,
  "reason" text,
  "paid_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "commission_entries_sale_user_rule_uq" UNIQUE ("business_id", "sale_id", "salesperson_user_id", "rule_id"),
  CONSTRAINT "commission_entries_method_check" CHECK (
    "calc_method" IN ('percentage_of_sales', 'fixed_per_sale', 'percentage_of_profit')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_entries_business_user_idx" ON "commission_entries" ("business_id", "salesperson_user_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_entries_sale_idx" ON "commission_entries" ("sale_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Sales targets — per user, per period type, achievement computed from
--    completed sales where the user is the SALESPERSON (or cashier fallback
--    documented in the report).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "sales_targets" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  /** daily | weekly | monthly | custom */
  "period_type" varchar(10) NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "target_amount" numeric(14, 2) NOT NULL,
  "created_by" integer REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_targets_period_check" CHECK (
    "period_type" IN ('daily', 'weekly', 'monthly', 'custom') AND "target_amount" >= 0
  ),
  CONSTRAINT "sales_targets_range_check" CHECK ("period_end" >= "period_start"),
  CONSTRAINT "sales_targets_user_period_uq" UNIQUE ("business_id", "user_id", "period_start", "period_end")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_targets_business_idx" ON "sales_targets" ("business_id", "period_end");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. RBAC — commission.view/manage + targets.manage.
-- ---------------------------------------------------------------------------
INSERT INTO "permissions" ("key", "module", "description")
VALUES
  ('commission.view', 'commission', 'View commission rules and entries'),
  ('commission.manage', 'commission', 'Manage commission rules and the entry lifecycle (approve, mark payable/paid, reverse)'),
  ('targets.manage', 'commission', 'Create and edit sales targets')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

INSERT INTO
    "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT
    rp.role_id,
    p.id
FROM
    "role_permissions" rp
    JOIN "permissions" p ON p.key IN ('commission.view', 'commission.manage', 'targets.manage')
WHERE
    rp.permission_id IN (
      SELECT id FROM "permissions" WHERE key IN ('settings.edit', 'reports.financial.view')
    )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
