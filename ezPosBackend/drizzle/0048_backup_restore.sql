-- 0047_backup_restore — Backup & Restore program (approved proposal, 2026-11-05)
-- Additive only: three new tables + enums. No changes to existing tables.

CREATE TYPE "backup_type" AS ENUM ('manual', 'scheduled', 'safety', 'pre_restore', 'upload');
CREATE TYPE "backup_status" AS ENUM ('pending', 'running', 'completed', 'failed', 'expired', 'deleted');
CREATE TYPE "backup_frequency" AS ENUM ('daily', 'weekly');
CREATE TYPE "restore_mode" AS ENUM ('full', 'new_business', 'selective');
CREATE TYPE "restore_status" AS ENUM ('pending', 'validating', 'running', 'verifying', 'completed', 'failed', 'cancelled');

CREATE TABLE "business_backups" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "type" "backup_type" DEFAULT 'manual' NOT NULL,
  "status" "backup_status" DEFAULT 'pending' NOT NULL,
  "storage_key" varchar(500),
  "file_name" varchar(250),
  "file_size" bigint,
  "sha256" varchar(64),
  "encryption" jsonb,
  "manifest" jsonb,
  "module_selection" jsonb,
  "error" text,
  "expires_at" timestamp with time zone,
  "verified_at" timestamp with time zone,
  "triggered_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- One in-flight backup per business: blocks concurrent duplicate jobs
-- (double-clicks and scheduler/manual races share the same guarantee).
CREATE UNIQUE INDEX "business_backups_one_active_uq" ON "business_backups"
  USING btree ("business_id") WHERE "status" IN ('pending', 'running');
CREATE INDEX "business_backups_business_created_idx" ON "business_backups"
  USING btree ("business_id", "created_at" DESC);

CREATE TABLE "backup_schedules" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT true NOT NULL,
  "frequency" "backup_frequency" DEFAULT 'daily' NOT NULL,
  "hour" integer DEFAULT 2 NOT NULL,
  "day_of_week" integer,
  "retention_days" integer DEFAULT 30 NOT NULL,
  "last_run_at" timestamp with time zone,
  "next_run_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "backup_schedules_business_uq" ON "backup_schedules" USING btree ("business_id");
CREATE INDEX "backup_schedules_due_idx" ON "backup_schedules" USING btree ("enabled", "next_run_at");

CREATE TABLE "restore_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "target_business_id" integer REFERENCES "businesses"("id") ON DELETE SET NULL,
  "backup_id" integer REFERENCES "business_backups"("id") ON DELETE SET NULL,
  "mode" "restore_mode" NOT NULL,
  "modules" jsonb,
  "status" "restore_status" DEFAULT 'pending' NOT NULL,
  "stage" varchar(80),
  "progress" jsonb,
  "pre_restore_backup_id" integer REFERENCES "business_backups"("id") ON DELETE SET NULL,
  "result" jsonb,
  "error" text,
  "actor_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "restore_jobs_business_created_idx" ON "restore_jobs"
  USING btree ("business_id", "created_at" DESC);
