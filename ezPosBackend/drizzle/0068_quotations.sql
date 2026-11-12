-- 0068: Quotations / estimates (Phase 2B — approved audit report §5,
-- advanced-POS master prompt Feature 7).
--
-- GOVERNING PRINCIPLES:
-- 1. A quotation is an OFFER DOCUMENT with SNAPSHOT pricing — creating it
--    never deducts stock, and totals are computed server-side from the
--    quoted lines at creation time. Conversion re-runs the standard
--    backend-authoritative sale pricing on the quoted lines inside ONE
--    transaction; the quotation row is FOR UPDATE-locked, so double
--    conversion is impossible (status guard + row lock).
-- 2. Statuses: draft → sent → accepted/rejected/expired/converted/cancelled.
--    The expiry sweep marks draft/sent with valid_until in the past.
-- 3. ADDITIVE ONLY; rollback = DROP the two tables + the permission rows.

CREATE TYPE "quotation_status" AS ENUM (
  'draft', 'sent', 'accepted', 'rejected', 'expired', 'converted', 'cancelled'
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quotations" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "location_id" integer NOT NULL,
  "quote_number" varchar(40) NOT NULL,
  "customer_id" integer REFERENCES "customers" ("id") ON DELETE SET NULL,
  "customer_name_snapshot" varchar(255),
  "status" "quotation_status" NOT NULL DEFAULT 'draft',
  "subtotal" numeric(12, 2) NOT NULL DEFAULT 0,
  "discount_total" numeric(12, 2) NOT NULL DEFAULT 0,
  "vat_total" numeric(12, 2) NOT NULL DEFAULT 0,
  "grand_total" numeric(12, 2) NOT NULL DEFAULT 0,
  "vat_percent" numeric(5, 2) NOT NULL DEFAULT 0,
  "notes" text,
  "terms" text,
  "valid_until" date,
  "converted_sale_id" integer,
  "converted_at" timestamp with time zone,
  "created_by" integer NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "quotations_business_number_uq" UNIQUE ("business_id", "quote_number"),
  -- Candidate key for the composite FK from quotation_items.
  CONSTRAINT "quotations_id_business_uq" UNIQUE ("id", "business_id"),
  CONSTRAINT "quotations_totals_check" CHECK (
    "subtotal" >= 0 AND "discount_total" >= 0 AND "vat_total" >= 0 AND "grand_total" >= 0
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotations_business_status_idx" ON "quotations" ("business_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotations_business_created_idx" ON "quotations" ("business_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotations_expiry_idx" ON "quotations" ("valid_until")
  WHERE "status" IN ('draft', 'sent');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quotation_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "quotation_id" integer NOT NULL,
  "variant_id" integer NOT NULL,
  "variant_name_snapshot" varchar(255) NOT NULL,
  "quantity" numeric(14, 4) NOT NULL,
  "unit_price" numeric(12, 2) NOT NULL,
  "discount" numeric(12, 2) NOT NULL DEFAULT 0,
  "line_total" numeric(12, 2) NOT NULL,
  FOREIGN KEY ("quotation_id", "business_id")
    REFERENCES "quotations" ("id", "business_id") ON DELETE CASCADE,
  FOREIGN KEY ("variant_id", "business_id") REFERENCES "product_variants" ("id", "business_id") ON DELETE RESTRICT,
  CONSTRAINT "quotation_items_values_check" CHECK (
    "quantity" > 0 AND "unit_price" >= 0 AND "discount" >= 0 AND "line_total" >= 0
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotation_items_quotation_idx" ON "quotation_items" ("quotation_id", "id");
--> statement-breakpoint

-- RBAC: quotation permissions (grants mirror the sales audiences).
INSERT INTO "permissions" ("key", "module", "description")
VALUES
  ('quotations.view', 'quotations', 'View quotations and estimates'),
  ('quotations.create', 'quotations', 'Create and edit quotations'),
  ('quotations.convert', 'quotations', 'Convert accepted quotations into sales')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

INSERT INTO
    "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT
    rp.role_id,
    p.id
FROM
    "role_permissions" rp
    JOIN "permissions" p ON p.key IN ('quotations.view', 'quotations.create')
WHERE
    rp.permission_id IN (
      SELECT id FROM "permissions" WHERE key IN ('sales.view', 'pos.create_sale')
    )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO
    "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT
    rp.role_id,
    p.id
FROM
    "role_permissions" rp
    JOIN "permissions" p ON p.key = 'quotations.convert'
WHERE
    rp.permission_id IN (
      SELECT id FROM "permissions" WHERE key = 'pos.create_sale'
    )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
