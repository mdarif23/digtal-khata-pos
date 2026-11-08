-- 0054: Owner finance (Finance & Growth Stage 4, owner-approved schema).
-- docs/finance-growth/phase-0-audit-and-architecture.md §8 (Phases 1-2).
--
-- 1) owner_profiles — multiple business owners with ownership percentages
--    and per-owner capital history (percentages deliberately NOT assumed to
--    match contributions).
-- 2) capital_transactions — investments, withdrawals (capital repayment)
--    and profit distributions, each posted to the GL:
--      investment     DR cash / CR 3010 Owner Contributions
--      withdrawal     DR 3020 Owner Drawings / CR cash
--      distribution   DR 3020 Owner Drawings / CR cash
-- 3) profit_allocations + profit_allocation_lines — designation of
--    distributable profit into reserves/reinvestment/distribution. An
--    allocation is NOT a cash movement and posts NO journal entry; the
--    realized owner-distribution share becomes an actual capital
--    transaction (which posts).
--
-- All money columns numeric(14,2). No cascading deletes on posted history.

CREATE TYPE "capital_transaction_type" AS ENUM ('investment', 'withdrawal', 'distribution');
CREATE TYPE "profit_allocation_status" AS ENUM ('confirmed', 'reversed');
CREATE TYPE "profit_allocation_category" AS ENUM (
  'reinvestment', 'owner_distribution', 'emergency_reserve',
  'expansion', 'debt_repayment', 'other'
);

CREATE TABLE "owner_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"user_id" integer,
	"name" varchar(120) NOT NULL,
	"phone" varchar(30),
	"email" varchar(255),
	"ownership_percent" numeric(5, 2),
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" varchar(500),
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "owner_profiles" ADD CONSTRAINT "owner_profiles_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "owner_profiles" ADD CONSTRAINT "owner_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "owner_profiles" ADD CONSTRAINT "owner_profiles_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- One ACTIVE owner profile per platform user per business (NULL user_id
-- rows are book-owners without login accounts and are exempt).
CREATE UNIQUE INDEX "owner_profiles_active_user_unique" ON "owner_profiles" USING btree ("business_id","user_id") WHERE "is_active" = true AND "user_id" IS NOT NULL;
-- Candidate key for the composite FK from capital_transactions.
CREATE UNIQUE INDEX "owner_profiles_id_business_uq" ON "owner_profiles" USING btree ("id","business_id");
CREATE INDEX "owner_profiles_business_idx" ON "owner_profiles" USING btree ("business_id","is_active");

CREATE TABLE "capital_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"owner_profile_id" integer NOT NULL,
	"type" "capital_transaction_type" NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"txn_date" date NOT NULL,
	"payment_account_id" integer,
	"method" varchar(30),
	"source_of_funds" varchar(120),
	"reference" varchar(100),
	"description" varchar(500),
	"attachment_url" varchar(500),
	"journal_entry_id" integer,
	"client_uuid" uuid,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capital_transactions_amount_positive_check" CHECK ("amount" > 0)
);
ALTER TABLE "capital_transactions" ADD CONSTRAINT "capital_transactions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "capital_transactions" ADD CONSTRAINT "capital_transactions_owner_business_fkey" FOREIGN KEY ("owner_profile_id","business_id") REFERENCES "owner_profiles"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- The payment account must belong to the same business.
ALTER TABLE "capital_transactions" ADD CONSTRAINT "capital_transactions_payment_account_business_fkey" FOREIGN KEY ("payment_account_id","business_id") REFERENCES "payment_accounts"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "capital_transactions" ADD CONSTRAINT "capital_transactions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "capital_transactions_id_business_uq" ON "capital_transactions" USING btree ("id","business_id");
CREATE UNIQUE INDEX "capital_transactions_client_uuid_unique" ON "capital_transactions" USING btree ("client_uuid");
CREATE INDEX "capital_transactions_business_date_idx" ON "capital_transactions" USING btree ("business_id","txn_date");
CREATE INDEX "capital_transactions_business_owner_idx" ON "capital_transactions" USING btree ("business_id","owner_profile_id","txn_date");

CREATE TABLE "profit_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"period_label" varchar(60),
	/** Snapshot of the verified figures the allocation was based on. */
	"basis_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total_distributable" numeric(14, 2) NOT NULL,
	"total_allocated" numeric(14, 2) NOT NULL,
	"status" "profit_allocation_status" DEFAULT 'confirmed' NOT NULL,
	"reversal_reason" varchar(500),
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profit_allocations_period_order_check" CHECK ("period_end" >= "period_start")
);
ALTER TABLE "profit_allocations" ADD CONSTRAINT "profit_allocations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "profit_allocations" ADD CONSTRAINT "profit_allocations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- Candidate key for the composite FK from profit_allocation_lines.
CREATE UNIQUE INDEX "profit_allocations_id_business_uq" ON "profit_allocations" USING btree ("id","business_id");
CREATE INDEX "profit_allocations_business_period_idx" ON "profit_allocations" USING btree ("business_id","period_start","period_end");

CREATE TABLE "profit_allocation_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"allocation_id" integer NOT NULL,
	"business_id" integer NOT NULL,
	"category" "profit_allocation_category" NOT NULL,
	"basis_type" varchar(10) NOT NULL,
	"basis_value" numeric(9, 4),
	"amount" numeric(14, 2) NOT NULL,
	"realized_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"realized_at" timestamp with time zone,
	"realized_reference" varchar(100),
	"realized_capital_transaction_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profit_allocation_lines_amount_nonnegative_check" CHECK ("amount" >= 0 AND "realized_amount" >= 0),
	CONSTRAINT "profit_allocation_lines_basis_check" CHECK (
		("basis_type" = 'percent' AND "basis_value" IS NOT NULL)
		OR ("basis_type" = 'fixed')
	)
);
ALTER TABLE "profit_allocation_lines" ADD CONSTRAINT "profit_allocation_lines_allocation_business_fkey" FOREIGN KEY ("allocation_id","business_id") REFERENCES "profit_allocations"("id","business_id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "profit_allocation_lines" ADD CONSTRAINT "profit_allocation_lines_capital_txn_fkey" FOREIGN KEY ("realized_capital_transaction_id") REFERENCES "capital_transactions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
CREATE INDEX "profit_allocation_lines_allocation_idx" ON "profit_allocation_lines" USING btree ("allocation_id");
