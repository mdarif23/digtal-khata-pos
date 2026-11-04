-- 0039: Expense management foundation — settlement payments, soft void,
-- payee, category lifecycle. Companion to the expense module refactor.
--
-- Semantics:
-- * An expense is a COST INCURRED (expense_date, amount) — reports and net
--   profit keep summing expenses.amount (accrual), unchanged.
-- * A payment is a SETTLEMENT of that cost (expense_payments, payment_date).
-- * Legacy rows were "recorded = settled": backfilled paid + one payment row
--   each so Z-report cash figures stay identical for historical data.
-- * Soft void (deleted_at) replaces hard delete; voided expenses are excluded
--   from every financial view.

-- ---------------------------------------------------------------------------
-- expenses: settlement + lifecycle columns
-- ---------------------------------------------------------------------------
ALTER TABLE "expenses" ADD COLUMN "payee" varchar(150);
ALTER TABLE "expenses" ADD COLUMN "paid_amount" numeric(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE "expenses" ADD COLUMN "payment_status" varchar(10) NOT NULL DEFAULT 'unpaid';
ALTER TABLE "expenses" ADD COLUMN "created_by" integer;
ALTER TABLE "expenses" ADD COLUMN "updated_by" integer;
ALTER TABLE "expenses" ADD COLUMN "deleted_at" timestamp;
ALTER TABLE "expenses" ADD COLUMN "deleted_by" integer;
ALTER TABLE "expenses" ADD COLUMN "void_reason" text;

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payment_status_check" CHECK (
    "payment_status" IN ('unpaid', 'partial', 'paid')
);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_users_fk" FOREIGN KEY ("created_by") REFERENCES "users" ("id");
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_updated_by_users_fk" FOREIGN KEY ("updated_by") REFERENCES "users" ("id");
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_deleted_by_users_fk" FOREIGN KEY ("deleted_by") REFERENCES "users" ("id");

-- Business-scoped identity, required by the expense_payments composite FK
-- below (same pattern as expense_categories_id_business_uq / locations).
CREATE UNIQUE INDEX IF NOT EXISTS "expenses_id_business_uq" ON "expenses" ("id", "business_id");

CREATE INDEX IF NOT EXISTS "expenses_business_date_idx" ON "expenses" ("business_id", "expense_date" DESC);
CREATE INDEX IF NOT EXISTS "expenses_business_status_idx" ON "expenses" ("business_id", "payment_status");
CREATE INDEX IF NOT EXISTS "expenses_business_category_idx" ON "expenses" ("business_id", "category_id");

-- Legacy semantics: a recorded expense was settled at record time.
UPDATE "expenses"
SET "paid_amount" = "amount",
    "payment_status" = 'paid';

-- ---------------------------------------------------------------------------
-- expense_payments: settlement ledger for expenses
-- ---------------------------------------------------------------------------
CREATE TABLE "expense_payments" (
    "id" SERIAL PRIMARY KEY,
    "business_id" integer NOT NULL,
    "expense_id" integer NOT NULL,
    "amount" numeric(10, 2) NOT NULL,
    "payment_method" varchar(50) NOT NULL,
    "payment_date" date NOT NULL DEFAULT CURRENT_DATE,
    "reference_no" varchar(100),
    "note" text,
    "recorded_by" integer,
    "register_session_id" integer,
    "location_id" integer,
    -- Client-generated idempotency key: a retried submit can never create a
    -- duplicate settlement (NULLs never collide).
    "client_uuid" uuid,
    "created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "expense_payments_amount_positive_check" CHECK ("amount" > (0)::numeric),
    CONSTRAINT "expense_payments_method_valid_check" CHECK (
        ("payment_method")::text = ANY (
            (
                ARRAY['Cash'::character varying, 'Mobile'::character varying, 'Card'::character varying]
            )::text[]
        )
    )
);

ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_expense_business_fkey" FOREIGN KEY ("expense_id", "business_id") REFERENCES "expenses" ("id", "business_id");
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_recorded_by_users_fk" FOREIGN KEY ("recorded_by") REFERENCES "users" ("id");
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_session_business_fkey" FOREIGN KEY ("register_session_id", "business_id") REFERENCES "register_sessions" ("id", "business_id");
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_location_business_fkey" FOREIGN KEY ("location_id", "business_id") REFERENCES "locations" ("id", "business_id");

-- Same duplicate-submission protection as sale_payments: within a business,
-- one settlement per (method, reference). NULL references never collide.
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_business_method_reference_unique" UNIQUE ("business_id", "payment_method", "reference_no");
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_client_uuid_unique" UNIQUE ("client_uuid");

CREATE INDEX IF NOT EXISTS "expense_payments_expense_id_idx" ON "expense_payments" ("expense_id");
CREATE INDEX IF NOT EXISTS "expense_payments_business_date_idx" ON "expense_payments" ("business_id", "payment_date");
CREATE INDEX IF NOT EXISTS "expense_payments_session_idx" ON "expense_payments" ("register_session_id");

-- Legacy backfill: one settlement row per existing expense (all rows were
-- treated as paid-in-full at record time). Guarded to amount > 0 because the
-- payments ledger forbids zero-amount rows; zero-amount expenses are already
-- settled by definition (nothing owed).
INSERT INTO
    "expense_payments" (
        "business_id",
        "expense_id",
        "amount",
        "payment_method",
        "payment_date",
        "note",
        "location_id",
        "created_at"
    )
SELECT
    "business_id",
    "id",
    "amount",
    COALESCE("payment_method", 'Cash'),
    "expense_date",
    'Backfilled from the expense record (migration 0039)',
    "location_id",
    COALESCE("created_at", CURRENT_TIMESTAMP)
FROM
    "expenses"
WHERE
    "amount" > 0;

-- ---------------------------------------------------------------------------
-- expense_categories: lifecycle + presentation
-- ---------------------------------------------------------------------------
ALTER TABLE "expense_categories" ADD COLUMN "description" varchar(255);
ALTER TABLE "expense_categories" ADD COLUMN "color" varchar(20);
ALTER TABLE "expense_categories" ADD COLUMN "icon" varchar(50);
ALTER TABLE "expense_categories" ADD COLUMN "archived_at" timestamp;

-- Archived categories may share a name with a fresh active one; only active
-- names stay unique per business (supersedes
-- expense_categories_business_name_unique from migration 0001).
ALTER TABLE "expense_categories" DROP CONSTRAINT IF EXISTS "expense_categories_business_name_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "expense_categories_business_name_active_unique" ON "expense_categories" ("business_id", "category_name")
WHERE
    "archived_at" IS NULL;

-- ---------------------------------------------------------------------------
-- RBAC: expenses.pay — auto-granted to every role that can already edit
-- expenses (accountant preset, custom roles). The key is also added to
-- PERMISSION_CATALOG (seed is idempotent), but the grant for EXISTING
-- businesses' roles must happen here — ensureRbacSeed only inserts keys.
-- ---------------------------------------------------------------------------
INSERT INTO
    "permissions" ("key", "module", "description")
VALUES
    (
        'expenses.pay',
        'expenses',
        'Record expense payments'
    )
ON CONFLICT ("key") DO NOTHING;

INSERT INTO
    "role_permissions" ("role_id", "permission_id")
SELECT
    rp.role_id,
    pay.id
FROM
    "role_permissions" rp
    JOIN "permissions" edit ON edit.key = 'expenses.edit'
    JOIN "permissions" pay ON pay.key = 'expenses.pay'
WHERE
    rp.permission_id = edit.id
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
