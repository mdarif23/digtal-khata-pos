-- Full offline mode per terminal (Phase 3): server-enforced offline stock
-- allocations, conflict records for unsafe-to-auto-apply sync ops, the
-- per-product offline selling policy, and client-side idempotency ids for
-- offline drawer sessions/movements. All additive.

-- 1. Per-product offline selling policy. 'allocated' (default): the
-- terminal may sell up to its server-granted allowance. 'blocked': no
-- offline selling (serial-tracked products are ALWAYS blocked by code —
-- the same serial must never sell twice). 'open': sell freely offline;
-- overages auto-apply and land in sync_conflicts for manager review.
ALTER TABLE "products" ADD COLUMN "offline_policy" varchar(20) NOT NULL DEFAULT 'allocated';--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_offline_policy_check" CHECK ("offline_policy" IN ('allocated', 'blocked', 'open'));--> statement-breakpoint

-- 2. Business-level offline knobs.
ALTER TABLE "pos_settings" ADD COLUMN "offline_allocation_ttl_hours" integer NOT NULL DEFAULT 24;--> statement-breakpoint
ALTER TABLE "pos_settings" ADD COLUMN "offline_refund_cap" numeric(10,2);--> statement-breakpoint

-- 3. The allocation ledger — enforced by the authoritative server,
-- non-reusable by two terminals (partial unique: one ACTIVE allocation per
-- terminal+variant). consumed_qty is what the terminal actually sold
-- offline; overages never silently extend the allowance.
CREATE TABLE "offline_allocations" (
  "id" serial PRIMARY KEY,
  "business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "location_id" integer NOT NULL,
  "terminal_id" integer NOT NULL REFERENCES "pos_terminals"("id") ON DELETE CASCADE,
  "variant_id" integer NOT NULL REFERENCES "product_variants"("id") ON DELETE CASCADE,
  "allocated_qty" integer NOT NULL,
  "consumed_qty" integer NOT NULL DEFAULT 0,
  "status" varchar(20) NOT NULL DEFAULT 'active',
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "offline_allocations_qty_check" CHECK ("allocated_qty" >= 0 AND "consumed_qty" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "offline_allocations_active_terminal_variant_uq"
  ON "offline_allocations" ("terminal_id", "variant_id")
  WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "offline_allocations_active_idx"
  ON "offline_allocations" ("business_id", "variant_id")
  WHERE "status" = 'active';--> statement-breakpoint

-- 4. Conflict records: sync ops that would be unsafe to auto-apply. Open
-- items surface in the terminal sync dashboard for manager review.
CREATE TABLE "sync_conflicts" (
  "id" serial PRIMARY KEY,
  "business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "terminal_id" integer REFERENCES "pos_terminals"("id") ON DELETE SET NULL,
  "op_id" varchar(120) NOT NULL,
  "op_type" varchar(50) NOT NULL,
  "reason" varchar(50) NOT NULL,
  "message" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}',
  "status" varchar(30) NOT NULL DEFAULT 'open',
  "resolved_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "resolved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sync_conflicts_status_check" CHECK ("status" IN ('open', 'resolved_discarded', 'resolved_applied'))
);--> statement-breakpoint
CREATE INDEX "sync_conflicts_open_idx"
  ON "sync_conflicts" ("business_id", "status")
  WHERE "status" = 'open';--> statement-breakpoint

-- 5. Client-side idempotency ids for offline drawer operations: a browser
-- queuing an open/movement/close must be able to replay it safely.
ALTER TABLE "register_sessions" ADD COLUMN "client_session_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "register_sessions_client_session_uq"
  ON "register_sessions" ("client_session_id")
  WHERE "client_session_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "register_transactions" ADD COLUMN "client_op_id" varchar(120);--> statement-breakpoint
CREATE UNIQUE INDEX "register_transactions_client_op_uq"
  ON "register_transactions" ("client_op_id")
  WHERE "client_op_id" IS NOT NULL;
