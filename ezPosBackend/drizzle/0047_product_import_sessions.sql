-- 0047: Product import/export sessions (approved 2026-11-05).
--
-- product_import_sessions: one row per bulk product import run. Persists the
-- whole pipeline state (upload -> mapping -> validation -> execution ->
-- results) so the wizard survives navigation and row-level errors remain
-- downloadable. Original file bytes are NOT retained — parsing happens
-- in memory (size/row capped) and only normalized rows persist.
--
-- product_import_rows: per-row normalized payload + execution result, keyed
-- by ORIGINAL spreadsheet row number for error reporting.
--
-- Concurrency: the partial unique index enforces exactly ONE running session
-- per business. file_hash enables repeated-upload (idempotency) detection.

CREATE TYPE "product_import_status" AS ENUM('draft', 'mapped', 'validated', 'running', 'completed', 'failed', 'cancelled');
CREATE TYPE "product_import_row_status" AS ENUM('pending', 'valid', 'error', 'created', 'updated', 'skipped', 'failed');
CREATE TYPE "product_import_mode" AS ENUM('create', 'update', 'upsert', 'skip');
CREATE TYPE "product_import_match_by" AS ENUM('variant_sku', 'product_sku', 'barcode');
--> statement-breakpoint
CREATE TABLE "product_import_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"created_by" integer NOT NULL,
	"filename" varchar(255) NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"file_size" integer NOT NULL,
	"worksheet" varchar(200),
	"header_row" integer DEFAULT 1 NOT NULL,
	"status" "product_import_status" DEFAULT 'draft' NOT NULL,
	"mode" "product_import_mode" DEFAULT 'create' NOT NULL,
	"match_by" "product_import_match_by" DEFAULT 'variant_sku' NOT NULL,
	"mapping" jsonb,
	"options" jsonb,
	"totals" jsonb DEFAULT '{}'::jsonb,
	"processing_ms" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_import_rows" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"session_id" integer NOT NULL,
	"row_number" integer NOT NULL,
	"product_ref" varchar(255),
	"status" "product_import_row_status" DEFAULT 'pending' NOT NULL,
	"payload" jsonb,
	"errors" jsonb,
	"result" jsonb
);
--> statement-breakpoint
CREATE INDEX "product_import_sessions_business_idx" ON "product_import_sessions" USING btree ("business_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "product_import_sessions_one_running_uq" ON "product_import_sessions" USING btree ("business_id") WHERE status = 'running';
--> statement-breakpoint
CREATE INDEX "product_import_sessions_hash_idx" ON "product_import_sessions" USING btree ("business_id","file_hash");
--> statement-breakpoint
CREATE INDEX "product_import_rows_session_idx" ON "product_import_rows" USING btree ("session_id","row_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "product_import_rows_id_business_uq" ON "product_import_rows" USING btree ("id","business_id");
--> statement-breakpoint
ALTER TABLE "product_import_sessions" ADD CONSTRAINT "product_import_sessions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "product_import_sessions" ADD CONSTRAINT "product_import_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "product_import_rows" ADD CONSTRAINT "product_import_rows_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;
