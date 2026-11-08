-- 0057: Loans, assets & depreciation (Finance & Growth Stage 7, Phase 7,
-- owner-approved schema).
--
-- GL treatment (posting hooks):
--   loan disbursed   DR cash / CR 2080 Loans Payable        (financing)
--   repayment        DR 2080 (principal) + DR 5090 (interest)
--                    / CR cash                              (financing+operating)
--   asset acquired   DR 1080/1081/1082 (by category) / CR cash-or-2010 (investing)
--   depreciation     DR 5100 / CR 1090 accumulated (contra-asset) — monthly,
--                    straight-line, idempotent per (asset, period month).

CREATE TYPE "loan_lender_type" AS ENUM ('bank', 'mfs', 'owner', 'other');
CREATE TYPE "loan_status" AS ENUM ('active', 'closed', 'written_off');
CREATE TYPE "asset_category" AS ENUM ('equipment', 'furniture', 'vehicle', 'other');
CREATE TYPE "asset_status" AS ENUM ('active', 'sold', 'written_off');

CREATE TABLE "business_loans" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"lender_type" "loan_lender_type" NOT NULL,
	"lender_name" varchar(120) NOT NULL,
	"principal" numeric(14, 2) NOT NULL,
	/** Annual percentage rate (nullable for interest-free/owner loans). */
	"interest_rate" numeric(6, 3),
	"loan_date" date NOT NULL,
	"due_date" date,
	"installment_count" integer,
	"installment_amount" numeric(14, 2),
	"status" "loan_status" DEFAULT 'active' NOT NULL,
	"notes" varchar(500),
	"journal_entry_id" integer,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_loans_principal_positive_check" CHECK ("principal" > 0)
);
ALTER TABLE "business_loans" ADD CONSTRAINT "business_loans_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "business_loans" ADD CONSTRAINT "business_loans_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "business_loans_id_business_uq" ON "business_loans" USING btree ("id","business_id");
CREATE INDEX "business_loans_business_status_idx" ON "business_loans" USING btree ("business_id","status");

CREATE TABLE "loan_repayments" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"loan_id" integer NOT NULL,
	"payment_date" date NOT NULL,
	"principal_amount" numeric(14, 2) NOT NULL,
	"interest_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"method" varchar(30),
	"payment_account_id" integer,
	"reference" varchar(100),
	"journal_entry_id" integer,
	"client_uuid" uuid,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_repayments_split_check" CHECK (
		"principal_amount" > 0 AND "interest_amount" >= 0
		AND "principal_amount" + "interest_amount" = "total_amount"
	)
);
ALTER TABLE "loan_repayments" ADD CONSTRAINT "loan_repayments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "loan_repayments" ADD CONSTRAINT "loan_repayments_loan_business_fkey" FOREIGN KEY ("loan_id","business_id") REFERENCES "business_loans"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "loan_repayments" ADD CONSTRAINT "loan_repayments_payment_account_business_fkey" FOREIGN KEY ("payment_account_id","business_id") REFERENCES "payment_accounts"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "loan_repayments" ADD CONSTRAINT "loan_repayments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "loan_repayments_client_uuid_unique" ON "loan_repayments" USING btree ("client_uuid");
CREATE INDEX "loan_repayments_loan_idx" ON "loan_repayments" USING btree ("loan_id");

CREATE TABLE "business_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"name" varchar(120) NOT NULL,
	"category" "asset_category" NOT NULL,
	"acquired_at" date NOT NULL,
	"cost" numeric(14, 2) NOT NULL,
	"salvage_value" numeric(14, 2) DEFAULT 0 NOT NULL,
	"useful_life_months" integer NOT NULL,
	"depreciation_method" varchar(20) DEFAULT 'straight_line' NOT NULL,
	"accumulated_depreciation" numeric(14, 2) DEFAULT 0 NOT NULL,
	"status" "asset_status" DEFAULT 'active' NOT NULL,
	"location_id" integer,
	"notes" varchar(500),
	"journal_entry_id" integer,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_assets_values_check" CHECK (
		"cost" > 0 AND "salvage_value" >= 0 AND "useful_life_months" > 0
	)
);
ALTER TABLE "business_assets" ADD CONSTRAINT "business_assets_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "business_assets" ADD CONSTRAINT "business_assets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "business_assets" ADD CONSTRAINT "business_assets_location_business_fkey" FOREIGN KEY ("location_id","business_id") REFERENCES "locations"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "business_assets_id_business_uq" ON "business_assets" USING btree ("id","business_id");
CREATE INDEX "business_assets_business_status_idx" ON "business_assets" USING btree ("business_id","status");

CREATE TABLE "asset_depreciation_postings" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"asset_id" integer NOT NULL,
	/** First day of the depreciated month — the idempotency key. */
	"period_month" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"accumulated_after" numeric(14, 2) NOT NULL,
	"journal_entry_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_depreciation_postings_amount_check" CHECK ("amount" >= 0)
);
ALTER TABLE "asset_depreciation_postings" ADD CONSTRAINT "asset_depreciation_postings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "asset_depreciation_postings" ADD CONSTRAINT "asset_depreciation_postings_asset_fkey" FOREIGN KEY ("asset_id") REFERENCES "business_assets"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- Idempotent depreciation: one posting per asset per month.
CREATE UNIQUE INDEX "asset_depreciation_postings_asset_month_unique" ON "asset_depreciation_postings" USING btree ("asset_id","period_month");
