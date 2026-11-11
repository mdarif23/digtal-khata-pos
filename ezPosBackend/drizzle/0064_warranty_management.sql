-- 0064: Warranty Management — Phases 1-9 (user-approved master prompt,
-- report docs/warranty-management/PHASE-0-AUDIT.md §11, decisions D1-D10).
--
-- GOVERNING PRINCIPLES:
-- 1. Warranty terms are SNAPSHOTTED on every issued warranty/claim row;
--    history never depends on current product configuration.
-- 2. Expiry is computed ONCE at issue time from the sale date (never the
--    claim date); "expired" is DERIVED from expiry_date, never stored.
-- 3. Serial-tracked products issue one warranty per serial; ordinary
--    products issue one quantity-based warranty per sale item.
-- 4. Supplier warranties/claims are a separate subsystem with explicit
--    recovery tracking (recovery_amount / cost_amount) so the shop can
--    measure its actual warranty-related expense.
--
-- ADDITIVE ONLY: everything here is a new table, a new enum value, or
-- permission rows. No existing column or table is altered. Products without
-- warranty config behave exactly as before. Rollback = DROP the seven new
-- tables + the permission rows + ALTER TYPE ... DROP VALUE 'warranty_certificate'.

-- ---------------------------------------------------------------------------
-- 1. product_warranty_configs — product-level default + variant override
--    (product_unit_conversions pattern: variant_id NULL = product default).
-- ---------------------------------------------------------------------------
CREATE TABLE "product_warranty_configs" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "product_id" integer NOT NULL,
  "variant_id" integer,
  "enabled" boolean DEFAULT true NOT NULL,
  "provider" varchar(30) DEFAULT 'manufacturer' NOT NULL,
  "warranty_type" varchar(30) DEFAULT 'comprehensive' NOT NULL,
  "duration" integer NOT NULL,
  "duration_unit" varchar(10) DEFAULT 'months' NOT NULL,
  "terms" text,
  "status" varchar(20) DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "product_warranty_configs_provider_check" CHECK (
    "provider" IN ('manufacturer','seller','distributor','supplier','third_party')
  ),
  CONSTRAINT "product_warranty_configs_type_check" CHECK (
    "warranty_type" IN ('repair','replacement','service','limited','parts_only','comprehensive')
  ),
  CONSTRAINT "product_warranty_configs_unit_check" CHECK (
    "duration_unit" IN ('days','months','years')
  ),
  CONSTRAINT "product_warranty_configs_duration_check" CHECK ("duration" > 0),
  CONSTRAINT "product_warranty_configs_status_check" CHECK (
    "status" IN ('active','inactive')
  )
);
ALTER TABLE "product_warranty_configs"
  ADD CONSTRAINT "product_warranty_configs_product_business_fkey"
  FOREIGN KEY ("product_id", "business_id") REFERENCES "products" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "product_warranty_configs"
  ADD CONSTRAINT "product_warranty_configs_variant_business_fkey"
  FOREIGN KEY ("variant_id", "business_id") REFERENCES "product_variants" ("id", "business_id") ON DELETE CASCADE;
CREATE UNIQUE INDEX "product_warranty_configs_product_variant_uq"
  ON "product_warranty_configs" ("product_id", COALESCE("variant_id", 0));
CREATE INDEX "product_warranty_configs_business_idx" ON "product_warranty_configs" ("business_id");
CREATE INDEX "product_warranty_configs_product_idx" ON "product_warranty_configs" ("product_id");

-- ---------------------------------------------------------------------------
-- 2. customer_warranties — issued at sale completion. One row per sold serial
--    (serial_id NOT NULL, quantity=1) or one per sale item (serial_id NULL,
--    quantity = line quantity). Terms are snapshots.
-- ---------------------------------------------------------------------------
CREATE TABLE "customer_warranties" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "location_id" integer NOT NULL,
  "warranty_number" varchar(30) NOT NULL,
  "sale_id" integer NOT NULL,
  "sale_item_id" integer NOT NULL,
  "customer_id" integer REFERENCES "customers" ("id"),
  "product_id" integer NOT NULL,
  "variant_id" integer NOT NULL,
  "serial_id" integer REFERENCES "serial_numbers" ("id"),
  "serial_number" varchar(100),
  "quantity" integer DEFAULT 1 NOT NULL,
  "returned_quantity" integer DEFAULT 0 NOT NULL,
  "provider" varchar(30) NOT NULL,
  "warranty_type" varchar(30) NOT NULL,
  "duration" integer NOT NULL,
  "duration_unit" varchar(10) NOT NULL,
  "terms" text,
  "start_date" timestamp with time zone NOT NULL,
  "expiry_date" timestamp with time zone NOT NULL,
  "status" varchar(20) DEFAULT 'active' NOT NULL,
  "voided_at" timestamp with time zone,
  "void_reason" varchar(200),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_warranties_status_check" CHECK (
    "status" IN ('active','voided','replaced','suspended')
  )
);
ALTER TABLE "customer_warranties"
  ADD CONSTRAINT "customer_warranties_location_business_fkey"
  FOREIGN KEY ("location_id", "business_id") REFERENCES "locations" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "customer_warranties"
  ADD CONSTRAINT "customer_warranties_sale_business_fkey"
  FOREIGN KEY ("sale_id", "business_id") REFERENCES "sales" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "customer_warranties"
  ADD CONSTRAINT "customer_warranties_sale_item_business_fkey"
  FOREIGN KEY ("sale_item_id", "business_id") REFERENCES "sale_items" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "customer_warranties"
  ADD CONSTRAINT "customer_warranties_product_business_fkey"
  FOREIGN KEY ("product_id", "business_id") REFERENCES "products" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "customer_warranties"
  ADD CONSTRAINT "customer_warranties_variant_business_fkey"
  FOREIGN KEY ("variant_id", "business_id") REFERENCES "product_variants" ("id", "business_id") ON DELETE CASCADE;
CREATE UNIQUE INDEX "customer_warranties_id_business_uq"
  ON "customer_warranties" ("id", "business_id");
CREATE UNIQUE INDEX "customer_warranties_number_business_uq"
  ON "customer_warranties" ("business_id", "warranty_number");
-- Duplicate-proof generation: at most one quantity-based warranty per sale
-- item and at most one warranty per serial.
CREATE UNIQUE INDEX "customer_warranties_sale_item_uq"
  ON "customer_warranties" ("sale_item_id") WHERE "serial_id" IS NULL;
CREATE UNIQUE INDEX "customer_warranties_serial_uq"
  ON "customer_warranties" ("serial_id") WHERE "serial_id" IS NOT NULL;
CREATE INDEX "customer_warranties_business_status_idx"
  ON "customer_warranties" ("business_id", "status");
CREATE INDEX "customer_warranties_expiry_idx"
  ON "customer_warranties" ("business_id", "expiry_date");
CREATE INDEX "customer_warranties_customer_idx"
  ON "customer_warranties" ("business_id", "customer_id");
CREATE INDEX "customer_warranties_sale_idx"
  ON "customer_warranties" ("business_id", "sale_id");
CREATE INDEX "customer_warranties_product_idx"
  ON "customer_warranties" ("business_id", "product_id", "variant_id");

-- ---------------------------------------------------------------------------
-- 3. warranty_claims — customer claim lifecycle; transitions enforced by the
--    claim service, eligibility validated against the parent warranty.
-- ---------------------------------------------------------------------------
CREATE TABLE "warranty_claims" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "location_id" integer NOT NULL,
  "claim_number" varchar(30) NOT NULL,
  "warranty_id" integer NOT NULL,
  "customer_id" integer REFERENCES "customers" ("id"),
  "product_id" integer NOT NULL,
  "variant_id" integer NOT NULL,
  "serial_id" integer,
  "serial_number" varchar(100),
  "claim_type" varchar(30) DEFAULT 'repair' NOT NULL,
  "status" varchar(30) DEFAULT 'submitted' NOT NULL,
  "resolution_type" varchar(30),
  "reported_problem" text NOT NULL,
  "inspection_notes" text,
  "assigned_user_id" integer REFERENCES "users" ("id"),
  "received_date" timestamp with time zone,
  "resolved_date" timestamp with time zone,
  "closed_date" timestamp with time zone,
  "repair_description" text,
  "parts_used" text,
  "repair_cost" numeric(12, 2) DEFAULT 0 NOT NULL,
  "replacement_variant_id" integer,
  "replacement_serial_number" varchar(100),
  "replacement_date" timestamp with time zone,
  "new_warranty_id" integer,
  "pickup_date" timestamp with time zone,
  "resolution_notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "warranty_claims_type_check" CHECK (
    "claim_type" IN ('repair','replacement','parts_replacement','service')
  ),
  CONSTRAINT "warranty_claims_status_check" CHECK (
    "status" IN ('submitted','under_inspection','approved','rejected','repairing','waiting_parts','ready_for_pickup','replaced','closed','cancelled')
  ),
  CONSTRAINT "warranty_claims_resolution_check" CHECK (
    "resolution_type" IS NULL OR
    "resolution_type" IN ('repair','replacement','parts_replacement','service','rejected')
  ),
  CONSTRAINT "warranty_claims_repair_cost_check" CHECK ("repair_cost" >= (0)::numeric)
);
ALTER TABLE "warranty_claims"
  ADD CONSTRAINT "warranty_claims_location_business_fkey"
  FOREIGN KEY ("location_id", "business_id") REFERENCES "locations" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "warranty_claims"
  ADD CONSTRAINT "warranty_claims_warranty_business_fkey"
  FOREIGN KEY ("warranty_id", "business_id") REFERENCES "customer_warranties" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "warranty_claims"
  ADD CONSTRAINT "warranty_claims_product_business_fkey"
  FOREIGN KEY ("product_id", "business_id") REFERENCES "products" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "warranty_claims"
  ADD CONSTRAINT "warranty_claims_variant_business_fkey"
  FOREIGN KEY ("variant_id", "business_id") REFERENCES "product_variants" ("id", "business_id") ON DELETE CASCADE;
CREATE UNIQUE INDEX "warranty_claims_id_business_uq"
  ON "warranty_claims" ("id", "business_id");
CREATE UNIQUE INDEX "warranty_claims_number_business_uq"
  ON "warranty_claims" ("business_id", "claim_number");
CREATE INDEX "warranty_claims_business_status_idx"
  ON "warranty_claims" ("business_id", "status");
CREATE INDEX "warranty_claims_warranty_idx"
  ON "warranty_claims" ("business_id", "warranty_id");
CREATE INDEX "warranty_claims_assigned_idx"
  ON "warranty_claims" ("business_id", "assigned_user_id");

-- ---------------------------------------------------------------------------
-- 4. warranty_claim_events — append-only claim history (sale_order_events
--    clone). Rows are never updated or deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE "warranty_claim_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "claim_id" integer NOT NULL,
  "warranty_id" integer NOT NULL,
  "event_type" varchar(40) NOT NULL,
  "previous_status" varchar(30),
  "new_status" varchar(30),
  "actor_type" varchar(20) DEFAULT 'user' NOT NULL,
  "actor_user_id" integer REFERENCES "users" ("id"),
  "actor_label" varchar(120),
  "note" text,
  "metadata" jsonb DEFAULT '{}',
  "created_at" timestamp with time zone DEFAULT now()
);
ALTER TABLE "warranty_claim_events"
  ADD CONSTRAINT "warranty_claim_events_claim_business_fkey"
  FOREIGN KEY ("claim_id", "business_id") REFERENCES "warranty_claims" ("id", "business_id") ON DELETE CASCADE;
CREATE INDEX "warranty_claim_events_claim_created_idx"
  ON "warranty_claim_events" ("claim_id", "created_at");
CREATE INDEX "warranty_claim_events_business_idx"
  ON "warranty_claim_events" ("business_id");

-- ---------------------------------------------------------------------------
-- 5. supplier_warranties — ONE row per purchase item (unique purchase_item_id
--    so receive-capture and retroactive entry cannot duplicate).
-- ---------------------------------------------------------------------------
CREATE TABLE "supplier_warranties" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "supplier_id" integer NOT NULL,
  "purchase_id" integer NOT NULL,
  "purchase_item_id" integer NOT NULL,
  "product_id" integer NOT NULL,
  "variant_id" integer NOT NULL,
  "batch_id" integer,
  "provider" varchar(30) DEFAULT 'supplier' NOT NULL,
  "duration" integer NOT NULL,
  "duration_unit" varchar(10) DEFAULT 'months' NOT NULL,
  "terms" text,
  "quantity" integer DEFAULT 0 NOT NULL,
  "claimed_quantity" integer DEFAULT 0 NOT NULL,
  "start_date" timestamp with time zone NOT NULL,
  "expiry_date" timestamp with time zone NOT NULL,
  "status" varchar(20) DEFAULT 'active' NOT NULL,
  "source" varchar(20) DEFAULT 'manual' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "supplier_warranties_status_check" CHECK (
    "status" IN ('active','voided','exhausted')
  ),
  CONSTRAINT "supplier_warranties_source_check" CHECK (
    "source" IN ('receive','manual')
  ),
  CONSTRAINT "supplier_warranties_unit_check" CHECK (
    "duration_unit" IN ('days','months','years')
  ),
  CONSTRAINT "supplier_warranties_duration_check" CHECK ("duration" > 0)
);
ALTER TABLE "supplier_warranties"
  ADD CONSTRAINT "supplier_warranties_supplier_business_fkey"
  FOREIGN KEY ("supplier_id", "business_id") REFERENCES "suppliers" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "supplier_warranties"
  ADD CONSTRAINT "supplier_warranties_purchase_business_fkey"
  FOREIGN KEY ("purchase_id", "business_id") REFERENCES "purchases" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "supplier_warranties"
  ADD CONSTRAINT "supplier_warranties_item_business_fkey"
  FOREIGN KEY ("purchase_item_id", "business_id") REFERENCES "purchase_items" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "supplier_warranties"
  ADD CONSTRAINT "supplier_warranties_product_business_fkey"
  FOREIGN KEY ("product_id", "business_id") REFERENCES "products" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "supplier_warranties"
  ADD CONSTRAINT "supplier_warranties_variant_business_fkey"
  FOREIGN KEY ("variant_id", "business_id") REFERENCES "product_variants" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "supplier_warranties"
  ADD CONSTRAINT "supplier_warranties_batch_business_fkey"
  FOREIGN KEY ("batch_id", "business_id") REFERENCES "inventory_batches" ("id", "business_id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "supplier_warranties_id_business_uq"
  ON "supplier_warranties" ("id", "business_id");
CREATE UNIQUE INDEX "supplier_warranties_purchase_item_uq"
  ON "supplier_warranties" ("purchase_item_id");
CREATE INDEX "supplier_warranties_business_status_idx"
  ON "supplier_warranties" ("business_id", "status");
CREATE INDEX "supplier_warranties_expiry_idx"
  ON "supplier_warranties" ("business_id", "expiry_date");
CREATE INDEX "supplier_warranties_supplier_idx"
  ON "supplier_warranties" ("business_id", "supplier_id");

-- ---------------------------------------------------------------------------
-- 6. supplier_warranty_claims — separate from customer claims; carries the
--    supplier's response, replacement and the value recovered by the shop.
-- ---------------------------------------------------------------------------
CREATE TABLE "supplier_warranty_claims" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "location_id" integer NOT NULL,
  "claim_number" varchar(30) NOT NULL,
  "supplier_warranty_id" integer NOT NULL,
  "supplier_id" integer NOT NULL,
  "purchase_id" integer NOT NULL,
  "product_id" integer NOT NULL,
  "variant_id" integer NOT NULL,
  "customer_warranty_claim_id" integer,
  "defective_quantity" integer NOT NULL,
  "serial_ids" jsonb DEFAULT '[]',
  "issue_description" text NOT NULL,
  "status" varchar(30) DEFAULT 'submitted' NOT NULL,
  "replacement_quantity" integer DEFAULT 0 NOT NULL,
  "replacement_serial_numbers" text,
  "replacement_received_date" timestamp with time zone,
  "replacement_batch_id" integer,
  "recovery_amount" numeric(12, 2) DEFAULT 0 NOT NULL,
  "recovery_method" varchar(20) DEFAULT 'none' NOT NULL,
  "recovery_reference_id" integer,
  "cost_amount" numeric(12, 2) DEFAULT 0 NOT NULL,
  "submitted_date" timestamp with time zone DEFAULT now() NOT NULL,
  "responded_date" timestamp with time zone,
  "resolved_date" timestamp with time zone,
  "closed_date" timestamp with time zone,
  "notes" text,
  "created_by_user_id" integer REFERENCES "users" ("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "supplier_warranty_claims_status_check" CHECK (
    "status" IN ('submitted','sent_to_supplier','under_repair','replaced','rejected','closed','cancelled')
  ),
  CONSTRAINT "supplier_warranty_claims_recovery_check" CHECK (
    "recovery_method" IN ('none','credit_note','replacement','cash')
  ),
  CONSTRAINT "supplier_warranty_claims_amount_check" CHECK (
    "recovery_amount" >= (0)::numeric AND "cost_amount" >= (0)::numeric
  )
);
ALTER TABLE "supplier_warranty_claims"
  ADD CONSTRAINT "supplier_warranty_claims_location_business_fkey"
  FOREIGN KEY ("location_id", "business_id") REFERENCES "locations" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "supplier_warranty_claims"
  ADD CONSTRAINT "supplier_warranty_claims_warranty_business_fkey"
  FOREIGN KEY ("supplier_warranty_id", "business_id") REFERENCES "supplier_warranties" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "supplier_warranty_claims"
  ADD CONSTRAINT "supplier_warranty_claims_supplier_business_fkey"
  FOREIGN KEY ("supplier_id", "business_id") REFERENCES "suppliers" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "supplier_warranty_claims"
  ADD CONSTRAINT "supplier_warranty_claims_purchase_business_fkey"
  FOREIGN KEY ("purchase_id", "business_id") REFERENCES "purchases" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "supplier_warranty_claims"
  ADD CONSTRAINT "supplier_warranty_claims_product_business_fkey"
  FOREIGN KEY ("product_id", "business_id") REFERENCES "products" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "supplier_warranty_claims"
  ADD CONSTRAINT "supplier_warranty_claims_variant_business_fkey"
  FOREIGN KEY ("variant_id", "business_id") REFERENCES "product_variants" ("id", "business_id") ON DELETE CASCADE;
ALTER TABLE "supplier_warranty_claims"
  ADD CONSTRAINT "supplier_warranty_claims_customer_claim_business_fkey"
  FOREIGN KEY ("customer_warranty_claim_id", "business_id") REFERENCES "warranty_claims" ("id", "business_id") ON DELETE SET NULL;
ALTER TABLE "supplier_warranty_claims"
  ADD CONSTRAINT "supplier_warranty_claims_replacement_batch_business_fkey"
  FOREIGN KEY ("replacement_batch_id", "business_id") REFERENCES "inventory_batches" ("id", "business_id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "supplier_warranty_claims_id_business_uq"
  ON "supplier_warranty_claims" ("id", "business_id");
CREATE UNIQUE INDEX "supplier_warranty_claims_number_business_uq"
  ON "supplier_warranty_claims" ("business_id", "claim_number");
CREATE INDEX "supplier_warranty_claims_business_status_idx"
  ON "supplier_warranty_claims" ("business_id", "status");
CREATE INDEX "supplier_warranty_claims_supplier_idx"
  ON "supplier_warranty_claims" ("business_id", "supplier_id");
CREATE INDEX "supplier_warranty_claims_warranty_idx"
  ON "supplier_warranty_claims" ("business_id", "supplier_warranty_id");

-- ---------------------------------------------------------------------------
-- 7. supplier_warranty_claim_events — append-only history.
-- ---------------------------------------------------------------------------
CREATE TABLE "supplier_warranty_claim_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "claim_id" integer NOT NULL,
  "supplier_warranty_id" integer NOT NULL,
  "event_type" varchar(40) NOT NULL,
  "previous_status" varchar(30),
  "new_status" varchar(30),
  "actor_type" varchar(20) DEFAULT 'user' NOT NULL,
  "actor_user_id" integer REFERENCES "users" ("id"),
  "actor_label" varchar(120),
  "note" text,
  "metadata" jsonb DEFAULT '{}',
  "created_at" timestamp with time zone DEFAULT now()
);
ALTER TABLE "supplier_warranty_claim_events"
  ADD CONSTRAINT "supplier_warranty_claim_events_claim_business_fkey"
  FOREIGN KEY ("claim_id", "business_id") REFERENCES "supplier_warranty_claims" ("id", "business_id") ON DELETE CASCADE;
CREATE INDEX "supplier_warranty_claim_events_claim_created_idx"
  ON "supplier_warranty_claim_events" ("claim_id", "created_at");
CREATE INDEX "supplier_warranty_claim_events_business_idx"
  ON "supplier_warranty_claim_events" ("business_id");

-- ---------------------------------------------------------------------------
-- 8. document type for the printable warranty certificate.
--    Additive value; nothing consumes it within this migration.
-- ---------------------------------------------------------------------------
ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'warranty_certificate';

-- ---------------------------------------------------------------------------
-- 9. RBAC — permission keys + grants to roles that already hold related keys.
--    ensureRbacSeed() seeds the keys for fresh databases; these INSERTs make
--    existing databases and existing custom roles consistent.
-- ---------------------------------------------------------------------------
INSERT INTO
    "permissions" ("key", "module", "description")
VALUES
    ('warranty.view', 'warranty', 'View the warranty registry and warranty details'),
    ('warranty.claim.create', 'warranty', 'Create customer warranty claims'),
    ('warranty.claim.manage', 'warranty', 'Manage claim lifecycle: inspect, approve/reject, repair, replace, ready, pickup'),
    ('warranty.claim.close', 'warranty', 'Close or cancel warranty claims'),
    ('warranty.supplier.view', 'warranty', 'View supplier warranties and supplier claims'),
    ('warranty.supplier.manage', 'warranty', 'Create and manage supplier warranties and supplier claims'),
    ('warranty.reports.view', 'warranty', 'View warranty reports and statistics'),
    ('warranty.config.manage', 'warranty', 'Manage product and variant warranty configuration')
ON CONFLICT ("key") DO NOTHING;

-- Read coverage: every role that can view sales can view warranties, create
-- claims and see supplier warranties + warranty reports.
INSERT INTO
    "role_permissions" ("role_id", "permission_id")
SELECT
    rp.role_id,
    p.id
FROM
    "role_permissions" rp
    JOIN "permissions" base ON base.key = 'sales.view'
    JOIN "permissions" p ON p.key IN (
        'warranty.view', 'warranty.claim.create',
        'warranty.supplier.view', 'warranty.reports.view'
    )
WHERE
    rp.permission_id = base.id
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- Manage coverage: every role that can process sale returns manages the
-- claim lifecycle, supplier warranties and warranty configuration (owner
-- holds the wildcard; managers are the operational audience).
INSERT INTO
    "role_permissions" ("role_id", "permission_id")
SELECT
    rp.role_id,
    p.id
FROM
    "role_permissions" rp
    JOIN "permissions" ret ON ret.key = 'sales.return'
    JOIN "permissions" p ON p.key IN (
        'warranty.claim.manage', 'warranty.claim.close',
        'warranty.supplier.manage', 'warranty.config.manage'
    )
WHERE
    rp.permission_id = ret.id
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
