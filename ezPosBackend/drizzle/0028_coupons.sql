-- Coupons (Module 6, Phase 4). Codes are business-scoped and stored in
-- plaintext (customers type them in — they are not secrets); usage limits
-- and redemption history prevent invalid reuse. Auto-applied promotions
-- (BOGO, category rules, scheduled campaigns) are a future engine on top
-- of this foundation.
CREATE TABLE "coupons" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
	"code" varchar(60) NOT NULL,
	"description" text,
	"discount_type" varchar(20) NOT NULL,
	"value" numeric(12, 2) NOT NULL,
	"min_order_amount" numeric(12, 2) DEFAULT 0 NOT NULL,
	"max_discount_amount" numeric(12, 2),
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"usage_limit" integer,
	"per_customer_limit" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_business_code_unique" UNIQUE("business_id","code"),
	CONSTRAINT "coupons_type_valid" CHECK ("coupons"."discount_type" in ('percentage','fixed')),
	CONSTRAINT "coupons_value_positive" CHECK ("coupons"."value" >= 0),
	CONSTRAINT "coupons_usage_nonnegative" CHECK ("coupons"."used_count" >= 0 AND "coupons"."usage_limit" IS NULL OR "coupons"."usage_limit" >= 0)
);--> statement-breakpoint
CREATE INDEX "coupons_business_idx" ON "coupons" ("business_id");--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
	"coupon_id" integer NOT NULL REFERENCES "coupons"("id") ON DELETE CASCADE,
	"sale_id" integer NOT NULL,
	"customer_id" integer,
	"discount_amount" numeric(12, 2) NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_redemptions_sale_unique" UNIQUE("sale_id"),
	CONSTRAINT "coupon_redemptions_discount_positive" CHECK ("coupon_redemptions"."discount_amount" > 0)
);--> statement-breakpoint
CREATE INDEX "coupon_redemptions_coupon_idx" ON "coupon_redemptions" ("coupon_id");
