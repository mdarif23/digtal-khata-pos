-- Attendance / timeclock (Module 8, Phase 4). Records are immutable once
-- clocked out — corrections go through manager approval, never edits.
-- Hours are computed from UTC timestamps; display is client-local.
-- Shift scheduling (and the late-arrival/overtime baselines it provides)
-- is a separate future feature.
CREATE TABLE "attendance_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
	"user_id" integer NOT NULL REFERENCES "users"("id"),
	"location_id" integer NOT NULL,
	"clock_in" timestamp with time zone DEFAULT now() NOT NULL,
	"clock_out" timestamp with time zone,
	"clock_in_note" text,
	"clock_out_note" text,
	"approved_by_user_id" integer REFERENCES "users"("id"),
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_records_location_business_fkey" FOREIGN KEY ("location_id","business_id") REFERENCES "locations"("id","business_id") ON DELETE CASCADE,
	CONSTRAINT "attendance_records_clock_order" CHECK ("attendance_records"."clock_out" IS NULL OR "attendance_records"."clock_out" > "attendance_records"."clock_in")
);--> statement-breakpoint
CREATE INDEX "attendance_records_business_user_idx" ON "attendance_records" ("business_id","user_id");--> statement-breakpoint
CREATE INDEX "attendance_records_open_idx" ON "attendance_records" ("business_id","user_id") WHERE "clock_out" IS NULL;--> statement-breakpoint
CREATE TABLE "attendance_breaks" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
	"record_id" integer NOT NULL REFERENCES "attendance_records"("id") ON DELETE CASCADE,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "attendance_breaks_order" CHECK ("attendance_breaks"."ended_at" IS NULL OR "attendance_breaks"."ended_at" > "attendance_breaks"."started_at")
);--> statement-breakpoint
CREATE INDEX "attendance_breaks_record_idx" ON "attendance_breaks" ("record_id");
