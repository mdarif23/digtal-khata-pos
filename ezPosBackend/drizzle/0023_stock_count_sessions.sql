-- Stock-count sessions (Module 2: barcode stocktaking + cycle counting).
-- The session freezes expected quantities at creation; the variance applied
-- at approval is counted − CURRENT stock (row-locked), so concurrent sales
-- or transfers between count and approval can never desync inventory.
CREATE TABLE "stock_count_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
	"location_id" integer NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"note" text,
	"scope" jsonb,
	"created_by_user_id" integer NOT NULL REFERENCES "users"("id"),
	"approved_by_user_id" integer REFERENCES "users"("id"),
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_count_sessions_location_business_fkey" FOREIGN KEY ("location_id","business_id") REFERENCES "locations"("id","business_id") ON DELETE CASCADE,
	CONSTRAINT "stock_count_sessions_status_valid" CHECK ("stock_count_sessions"."status" in ('open','completed','cancelled'))
);--> statement-breakpoint
CREATE INDEX "stock_count_sessions_business_idx" ON "stock_count_sessions" ("business_id","location_id");--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
	"session_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"expected_quantity" integer NOT NULL,
	"counted_quantity" integer,
	"counted_by_user_id" integer REFERENCES "users"("id"),
	"counted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_count_lines_session_variant_unique" UNIQUE("session_id","variant_id"),
	CONSTRAINT "stock_count_lines_counted_nonnegative" CHECK ("stock_count_lines"."counted_quantity" is null or "stock_count_lines"."counted_quantity" >= 0)
);--> statement-breakpoint
CREATE INDEX "stock_count_lines_session_idx" ON "stock_count_lines" ("session_id");
