-- Notification center (Module 14, Phase 5). Business-scoped notifications
-- generated from real backend events, with deduplication (a dedupe_key
-- suppresses repeats within its window), per-user read state, and per-user
-- per-kind muting. Delivery is in-app over the existing SSE stream; email
-- stays out of v1.
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
	"kind" varchar(40) NOT NULL,
	"severity" varchar(10) DEFAULT 'info' NOT NULL,
	"title" varchar(120) NOT NULL,
	"body" text,
	"payload" jsonb,
	"dedupe_key" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_severity_valid" CHECK ("notifications"."severity" in ('info','warning','critical'))
);--> statement-breakpoint
CREATE INDEX "notifications_business_created_idx" ON "notifications" ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_idx" ON "notifications" ("business_id","dedupe_key");--> statement-breakpoint
CREATE TABLE "notification_reads" (
	"notification_id" integer NOT NULL REFERENCES "notifications"("id") ON DELETE CASCADE,
	"user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("notification_id","user_id")
);--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"kind" varchar(40) NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	PRIMARY KEY ("user_id","kind")
);
