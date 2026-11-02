-- Shared held sales (Module 1 cross-register holds / Module 11).
-- Holds move from localStorage to the server so any authorized cashier at
-- any register can retrieve them. items is a slim cart snapshot; prices and
-- stock are re-validated at sale time. TTL-based expiry (configurable via
-- HELD_SALES_TTL_HOURS) with lazy cleanup on list + a scheduler sweep.
CREATE TABLE "held_sales" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
	"location_id" integer NOT NULL,
	"held_by_user_id" integer NOT NULL REFERENCES "users"("id"),
	"name" varchar(120) NOT NULL,
	"items" jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "held_sales_location_business_fkey" FOREIGN KEY ("location_id","business_id") REFERENCES "locations"("id","business_id") ON DELETE CASCADE,
	CONSTRAINT "held_sales_items_nonempty" CHECK (jsonb_array_length("held_sales"."items") > 0)
);--> statement-breakpoint
CREATE INDEX "held_sales_business_location_idx" ON "held_sales" ("business_id","location_id");--> statement-breakpoint
CREATE INDEX "held_sales_expires_idx" ON "held_sales" ("expires_at");
