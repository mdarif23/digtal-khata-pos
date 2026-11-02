-- Store credit / customer account ledger (Module 5 refund methods, Phase 1).
-- Pure transaction ledger: positive rows grant credit (refunds, manual
-- top-ups), negative rows consume it (sale payments). The balance is
-- SUM(amount) over the ledger — balances always reconcile by construction.
CREATE TABLE "customer_credits" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
	"customer_id" integer NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
	"amount" numeric(10, 2) NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"source_id" integer,
	"actor_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_credits_amount_nonzero" CHECK ("customer_credits"."amount" <> 0),
	CONSTRAINT "customer_credits_source_valid" CHECK ("customer_credits"."source_type" in ('refund','sale_payment','manual'))
);--> statement-breakpoint
CREATE INDEX "customer_credits_business_customer_idx" ON "customer_credits" ("business_id","customer_id");--> statement-breakpoint
-- Refunds can now settle as store credit; sale payments can spend it.
ALTER TABLE "sale_refunds" DROP CONSTRAINT "sale_refunds_method_valid";--> statement-breakpoint
ALTER TABLE "sale_refunds" ADD CONSTRAINT "sale_refunds_method_valid"
  CHECK ("refund_method" IS NULL OR "refund_method" in ('cash','original_payment','store_credit'));--> statement-breakpoint
ALTER TABLE "sale_payments" DROP CONSTRAINT "sale_payments_method_valid";--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_method_valid"
  CHECK ("sale_payments"."payment_method" in ('cash','bangla_qr','card','store_credit'));
