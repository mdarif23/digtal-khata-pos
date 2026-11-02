-- Loyalty program (Module 7, Phase 4). One program per business; a pure
-- points ledger (positive earn, negative redeem/reversal) whose balance is
-- SUM(points) — balances reconcile with their ledger by construction.
-- Expiration is deliberately NOT implemented yet: per-lot FIFO expiry is a
-- sweep feature, and a config field that does nothing would be a fake
-- implementation (master prompt Rule 3).
CREATE TABLE "loyalty_programs" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL UNIQUE REFERENCES "businesses"("id") ON DELETE CASCADE,
	"earn_rate" numeric(10, 4) DEFAULT 0.01 NOT NULL,
	"redeem_value" numeric(10, 4) DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_programs_rates_positive" CHECK ("loyalty_programs"."earn_rate" >= 0 AND "loyalty_programs"."redeem_value" >= 0)
);--> statement-breakpoint
CREATE TABLE "loyalty_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
	"customer_id" integer NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
	"points" numeric(12, 2) NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"source_id" integer,
	"actor_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_ledger_points_nonzero" CHECK ("loyalty_ledger"."points" <> 0),
	CONSTRAINT "loyalty_ledger_source_valid" CHECK ("loyalty_ledger"."source_type" in ('sale_earn','redeem','refund_reversal','manual'))
);--> statement-breakpoint
CREATE INDEX "loyalty_ledger_business_customer_idx" ON "loyalty_ledger" ("business_id","customer_id");--> statement-breakpoint
-- Points become a spendable payment method, like store credit.
ALTER TABLE "sale_payments" DROP CONSTRAINT "sale_payments_method_valid";--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_method_valid"
  CHECK ("sale_payments"."payment_method" in ('cash','bangla_qr','card','store_credit','loyalty_points'));
