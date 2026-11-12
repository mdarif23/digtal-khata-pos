-- 0065: Phase 1 Operational Foundation (user-approved audit report §5,
-- advanced-POS master prompt Features 4 + 12 + 11).
--
-- GOVERNING PRINCIPLES:
-- 1. ADDITIVE ONLY — every change is a new column, new table, new index or a
--    new trigger. No existing column is altered or dropped; existing
--    workflows keep their exact behaviour (all new policy flags default to
--    the previous behaviour).
-- 2. audit_log becomes richer (before/after states, location, actor role,
--    request id) and enforced append-only. Full backup restore DELETES
--    audit_log rows absent from the package (backupModules.ts), so the
--    append-only trigger is disabled around the restore path
--    (backupRestore.service.ts) — the escape hatch is explicit code, not a
--    session GUC that pooling would leak.
-- 3. Manager PINs are PER-USER, argon2-hashed, with lockout. Approvals are
--    one-time, op-bound, expiring tokens; the token is stored hashed.
-- 4. Denomination sheets are snapshots on the session (opening/close) —
--    history never depends on current configuration.
-- 5. Rollback = DROP the three new tables, the new columns, the trigger, and
--    the two permission rows.

-- ---------------------------------------------------------------------------
-- 1. audit_log extension — richer context for the centralized audit view.
--    location_id has no FK: business_id is nullable (ON DELETE SET NULL), so
--    the composite (id, business_id) FK locations needs is not expressible;
--    a plain integer matches entity_id's convention.
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_log"
  ADD COLUMN "location_id" integer,
  ADD COLUMN "actor_role" varchar(60),
  ADD COLUMN "before_state" jsonb,
  ADD COLUMN "after_state" jsonb,
  ADD COLUMN "request_id" varchar(64);

CREATE INDEX "audit_log_action_idx" ON "audit_log" ("business_id", "action");
CREATE INDEX "audit_log_actor_created_idx" ON "audit_log" ("actor_user_id", "created_at");

-- Append-only enforcement: the application has no UPDATE/DELETE code paths
-- for audit_log (convention becomes constraint). The backup/restore service
-- DISABLEs this trigger for the duration of a restore and re-enables it in a
-- finally block (see backupRestore.service.ts).
CREATE OR REPLACE FUNCTION forbid_audit_log_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (row id %)', OLD.id
    USING ERRCODE = '55006';
END;
$$;

CREATE TRIGGER "audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_mutation();

-- ---------------------------------------------------------------------------
-- 2. Manager PINs — per user, per business. pin_hash is argon2 (the same
--    hash the auth stack uses); plaintext is never stored or logged.
--    failed_attempts + locked_until implement the lockout policy
--    (MAX_PIN_FAILURES / PIN_LOCKOUT_MINUTES in services/managerApproval.ts).
-- ---------------------------------------------------------------------------
CREATE TABLE "manager_pins" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "pin_hash" text NOT NULL,
  "failed_attempts" integer NOT NULL DEFAULT 0,
  "locked_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "manager_pins_business_user_uq" UNIQUE ("business_id", "user_id")
);

-- ---------------------------------------------------------------------------
-- 3. Manager approvals — one-time, op-bound, expiring approval tokens.
--    verify-pin mints a row + returns the raw token once; only token_hash is
--    stored. The consuming endpoint passes the token back with the SAME
--    payload; payload_hash binds the approval to the exact operation being
--    approved (master prompt F12-D: "Approval must be bound to the exact
--    operation being approved").
-- ---------------------------------------------------------------------------
CREATE TABLE "manager_approvals" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "approver_user_id" integer NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "op_type" varchar(60) NOT NULL,
  "entity_type" varchar(40),
  "entity_id" integer,
  "payload_hash" varchar(64),
  "reason" text,
  "token_hash" varchar(64) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "manager_approvals_op_type_check" CHECK (char_length("op_type") > 0)
);

CREATE INDEX "manager_approvals_token_idx" ON "manager_approvals" ("token_hash");
CREATE INDEX "manager_approvals_business_created_idx" ON "manager_approvals" ("business_id", "created_at");

-- ---------------------------------------------------------------------------
-- 4. Denomination configuration — the coin/bill sheet a business counts cash
--    with (e.g. [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1]). Singleton row
--    per business; absent row = the service offers a BDT default set. The
--    JSON is validated by the service (positive numbers, unique, max 15).
-- ---------------------------------------------------------------------------
CREATE TABLE "register_denomination_configs" (
  "business_id" integer PRIMARY KEY REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "denominations" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ---------------------------------------------------------------------------
-- 5. Register session denomination sheets — snapshots taken at open/close.
--    Shape: [{ "value": 500, "count": 4 }, ...] validated by the service;
--    the rendered total must equal opening_cash / counted_cash.
-- ---------------------------------------------------------------------------
ALTER TABLE "register_sessions"
  ADD COLUMN "opening_denominations" jsonb,
  ADD COLUMN "counted_denominations" jsonb;

-- ---------------------------------------------------------------------------
-- 6. Cash-drop metadata on drawer movements. safe_deposit rows may record
--    who physically received the money and a reference slip number, plus a
--    separate confirmation (confirmed_by/at) by a manager — the drop is
--    still a single drawer movement (no double accounting: the reference
--    idempotency index is untouched).
-- ---------------------------------------------------------------------------
ALTER TABLE "register_transactions"
  ADD COLUMN "recipient_user_id" integer REFERENCES "users" ("id") ON DELETE SET NULL,
  ADD COLUMN "reference_no" varchar(60),
  ADD COLUMN "confirmed_by" integer REFERENCES "users" ("id") ON DELETE SET NULL,
  ADD COLUMN "confirmed_at" timestamp with time zone;

-- ---------------------------------------------------------------------------
-- 7. Mid-shift blind counts. A reconciliation is a COUNT EVENT, not a
--    movement — it must never change expected cash, only record the interim
--    variance. Composite FK to register_sessions(id, business_id) enforces
--    tenancy at the FK level.
-- ---------------------------------------------------------------------------
CREATE TABLE "register_reconciliations" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "session_id" integer NOT NULL,
  "expected_cash" numeric(10, 2) NOT NULL,
  "counted_cash" numeric(10, 2) NOT NULL,
  "difference" numeric(10, 2) NOT NULL,
  "counted_denominations" jsonb,
  "notes" text,
  "created_by" integer NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  FOREIGN KEY ("session_id", "business_id")
    REFERENCES "register_sessions" ("id", "business_id") ON DELETE CASCADE
);

CREATE INDEX "register_reconciliations_business_created_idx"
  ON "register_reconciliations" ("business_id", "created_at");
CREATE INDEX "register_reconciliations_session_idx"
  ON "register_reconciliations" ("session_id");

-- ---------------------------------------------------------------------------
-- 8. POS policy additions (per-business singleton, defaults = old behaviour):
--    require_open_drawer: when true, cash sales are rejected unless the
--      seller (or their terminal) has an open register session — closes the
--      "cash sold, drawer never opened, movement silently dropped" hole.
--      Default OFF (approved).
--    approval_required: which sensitive operations demand a manager
--      approval token, shape {"sale_refund":bool,"sale_cancel":bool,
--      "cash_movement":bool,"below_minimum_price":bool}. register_reopen is
--      ALWAYS approval-gated (code-enforced) and deliberately not stored.
-- ---------------------------------------------------------------------------
ALTER TABLE "pos_settings"
  ADD COLUMN "require_open_drawer" boolean NOT NULL DEFAULT false,
  ADD COLUMN "approval_required" jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 9. RBAC — new audit permission keys + grants to roles that already hold
--    related oversight keys (same pattern as 0064; ensureRbacSeed() seeds
--    fresh databases).
-- ---------------------------------------------------------------------------
INSERT INTO
    "permissions" ("key", "module", "description")
VALUES
    ('audit.view', 'audit', 'View the business audit log (search, filters, event detail)'),
    ('audit.export', 'audit', 'Export the business audit log to CSV')
ON CONFLICT ("key") DO NOTHING;

-- View coverage: financial-report and settings viewers are the audit audience.
INSERT INTO
    "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT
    rp.role_id,
    p.id
FROM
    "role_permissions" rp
    JOIN "permissions" p ON p.key = 'audit.view'
WHERE
    rp.permission_id IN (
      SELECT id FROM "permissions" WHERE key IN ('settings.view', 'reports.financial.view')
    )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- Export coverage: settings editors may export what they can view.
INSERT INTO
    "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT
    rp.role_id,
    p.id
FROM
    "role_permissions" rp
    JOIN "permissions" p ON p.key = 'audit.export'
WHERE
    rp.permission_id IN (
      SELECT id FROM "permissions" WHERE key = 'settings.edit'
    )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
