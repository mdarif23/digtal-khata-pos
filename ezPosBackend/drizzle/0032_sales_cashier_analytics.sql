-- Advanced analytics (Module 15, Phase 8). Cashier attribution on sales
-- enables staff-performance reporting; channel data already exists.
ALTER TABLE "sales" ADD COLUMN "cashier_user_id" integer REFERENCES "users"("id");--> statement-breakpoint
CREATE INDEX "sales_cashier_idx" ON "sales" ("cashier_user_id");
