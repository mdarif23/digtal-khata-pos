-- 0069: Customer communication foundation (Phase 2C — approved audit
-- report §5, advanced-POS master prompt Feature 6).
--
-- GOVERNING PRINCIPLES:
-- 1. Provider ABSTRACTION: per business+channel rows name a provider_key
--    (console | generic_http | whatsapp_cloud | resend) with AES-256-GCM
--    encrypted config. Secrets NEVER leave the server — the API returns a
--    masked preview only. No official WhatsApp Business API automation
--    beyond the official Cloud API; no unofficial scraping.
-- 2. Every outbound message persists to comm_messages FIRST (queued), then
--    delivery updates status (sent/failed + provider_message_id). Delivery
--    webhooks are HMAC-verified and idempotent per provider message id.
-- 3. CONSENT: marketing sends require the customer's marketing_opt_in;
--    transactional sends are skipped when transactional_opt_out is set.
--    A per-customer daily cap prevents abuse.
-- 4. ADDITIVE ONLY; rollback = DROP the four tables + the two customer
--    columns + comms.* permission rows.

CREATE TABLE IF NOT EXISTS "comm_providers" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "channel" varchar(10) NOT NULL,
  "provider_key" varchar(30) NOT NULL,
  "display_name" varchar(80),
  "config_encrypted" text,
  "is_default" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comm_providers_channel_check" CHECK ("channel" IN ('sms', 'whatsapp', 'email')),
  CONSTRAINT "comm_providers_key_check" CHECK ("provider_key" IN ('console', 'generic_http', 'whatsapp_cloud', 'resend')),
  CONSTRAINT "comm_providers_business_channel_key_uq" UNIQUE ("business_id", "channel", "provider_key")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "comm_providers_one_default_per_channel_uq"
  ON "comm_providers" ("business_id", "channel") WHERE "is_default" = true;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "comm_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "template_key" varchar(40) NOT NULL,
  "channel" varchar(10) NOT NULL,
  "name" varchar(120) NOT NULL,
  "body" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comm_templates_channel_check" CHECK ("channel" IN ('sms', 'whatsapp', 'email')),
  CONSTRAINT "comm_templates_key_check" CHECK ("template_key" IN ('sale_receipt', 'due_reminder', 'payment_received', 'custom')),
  CONSTRAINT "comm_templates_business_key_channel_uq" UNIQUE ("business_id", "template_key", "channel")
);
--> statement-breakpoint

CREATE TYPE "comm_message_status" AS ENUM ('queued', 'sent', 'failed');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "comm_messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "channel" varchar(10) NOT NULL,
  "provider_key" varchar(30) NOT NULL DEFAULT 'console',
  "recipient" varchar(255) NOT NULL,
  "customer_id" integer REFERENCES "customers" ("id") ON DELETE SET NULL,
  "template_key" varchar(40) NOT NULL DEFAULT 'custom',
  "message_class" varchar(20) NOT NULL DEFAULT 'transactional',
  "entity_type" varchar(40),
  "entity_id" integer,
  "body" text NOT NULL,
  "status" "comm_message_status" NOT NULL DEFAULT 'queued',
  "provider_message_id" varchar(120),
  "error" text,
  "retry_count" integer NOT NULL DEFAULT 0,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comm_messages_class_check" CHECK ("message_class" IN ('transactional', 'marketing'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comm_messages_business_created_idx" ON "comm_messages" ("business_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comm_messages_customer_idx" ON "comm_messages" ("business_id", "customer_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comm_messages_provider_ref_idx" ON "comm_messages" ("provider_key", "provider_message_id")
  WHERE "provider_message_id" IS NOT NULL;
--> statement-breakpoint

-- Communication settings singleton per business (defaults = previous
-- behaviour: nothing sends automatically).
CREATE TABLE IF NOT EXISTS "comm_settings" (
  "business_id" integer PRIMARY KEY REFERENCES "businesses" ("id") ON DELETE CASCADE,
  "auto_receipt_enabled" boolean NOT NULL DEFAULT false,
  "due_reminders_enabled" boolean NOT NULL DEFAULT false,
  "daily_cap_per_customer" integer NOT NULL DEFAULT 3,
  "webhook_secret" varchar(64),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comm_settings_cap_check" CHECK ("daily_cap_per_customer" BETWEEN 0 AND 50)
);
--> statement-breakpoint

-- Consent columns on customers (transactional vs marketing separation).
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "marketing_opt_in" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "transactional_opt_out" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- RBAC: comms permissions (managers get both; grants mirror settings.edit).
INSERT INTO "permissions" ("key", "module", "description")
VALUES
  ('comms.view', 'comms', 'View communication settings, templates and message log'),
  ('comms.manage', 'comms', 'Manage communication providers, templates and campaigns')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

INSERT INTO
    "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT
    rp.role_id,
    p.id
FROM
    "role_permissions" rp
    JOIN "permissions" p ON p.key IN ('comms.view', 'comms.manage')
WHERE
    rp.permission_id IN (
      SELECT id FROM "permissions" WHERE key = 'settings.edit'
    )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
