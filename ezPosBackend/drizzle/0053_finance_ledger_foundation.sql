-- 0053: Finance & Growth ledger foundation (owner-approved schema, Phase 0).
-- docs/finance-growth/phase-0-audit-and-architecture.md §7/§8.
--
-- 1) payment_accounts — the previously missing cash/bank/MFS entity, each
--    mapped to exactly one GL account.
-- 2) chart_of_accounts — per-business accounts (system accounts seeded at
--    Finance activation, users may add expense accounts).
-- 3) accounting_periods — month-granularity open/close control.
-- 4) journal_entries + journal_entry_lines — the double-entry journal.
--    Posted entries are immutable and idempotent per source event:
--    partial unique (business_id, source_type, source_id) WHERE posted.
--    All money columns are numeric(14,2) (read as strings by the app).
-- 5) Additive nullable FK columns linking existing operational ledgers to
--    payment accounts / GL accounts (legacy rows stay NULL).
-- 6) businesses.ledger_activated_at — go-live marker; posting is rejected
--    before activation.

-- ============ enums ============
CREATE TYPE "finance_account_type" AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');
CREATE TYPE "finance_normal_balance" AS ENUM ('debit', 'credit');
CREATE TYPE "finance_cash_flow_category" AS ENUM ('none', 'operating', 'investing', 'financing');
CREATE TYPE "accounting_period_status" AS ENUM ('open', 'closed');
CREATE TYPE "journal_entry_status" AS ENUM ('draft', 'posted', 'reversed');
CREATE TYPE "journal_cash_flow_category" AS ENUM ('none', 'operating', 'investing', 'financing');
CREATE TYPE "payment_account_type" AS ENUM ('cash', 'bank', 'mfs');

-- ============ chart_of_accounts ============
CREATE TABLE "chart_of_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(120) NOT NULL,
	"type" "finance_account_type" NOT NULL,
	"normal_balance" "finance_normal_balance" NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_cash" boolean DEFAULT false NOT NULL,
	"cash_flow_category" "finance_cash_flow_category" DEFAULT 'none' NOT NULL,
	"parent_id" integer,
	"description" varchar(255),
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chart_of_accounts_business_code_unique" UNIQUE("business_id","code")
);
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_parent_id_chart_of_accounts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "chart_of_accounts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "chart_of_accounts_id_business_uq" ON "chart_of_accounts" USING btree ("id","business_id");
CREATE INDEX "chart_of_accounts_business_type_idx" ON "chart_of_accounts" USING btree ("business_id","type");
CREATE INDEX "chart_of_accounts_business_parent_idx" ON "chart_of_accounts" USING btree ("business_id","parent_id");

-- ============ accounting_periods ============
CREATE TABLE "accounting_periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" "accounting_period_status" DEFAULT 'open' NOT NULL,
	"closed_by_user_id" integer,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_periods_business_start_unique" UNIQUE("business_id","period_start")
);
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX "accounting_periods_business_status_idx" ON "accounting_periods" USING btree ("business_id","status");

-- ============ journal_entries ============
CREATE TABLE "journal_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"entry_no" varchar(30) NOT NULL,
	"entry_date" date NOT NULL,
	"memo" text,
	"source_type" varchar(40),
	"source_id" integer,
	"cash_flow_category" "journal_cash_flow_category" DEFAULT 'none' NOT NULL,
	"status" "journal_entry_status" DEFAULT 'draft' NOT NULL,
	"reversal_of_entry_id" integer,
	"reversal_reason" text,
	"posted_by_user_id" integer,
	"posted_at" timestamp with time zone,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_business_entry_no_unique" UNIQUE("business_id","entry_no"),
	CONSTRAINT "journal_entries_reversal_reason_check" CHECK (
		"reversal_of_entry_id" IS NULL OR "reversal_reason" IS NOT NULL
	)
);
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_of_entry_id") REFERENCES "journal_entries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "journal_entries_id_business_uq" ON "journal_entries" USING btree ("id","business_id");
-- Idempotent posting: one posted entry per source document event. Replays
-- of a posting hook hit this index and are treated as already-applied.
CREATE UNIQUE INDEX "journal_entries_source_posted_uq" ON "journal_entries" USING btree ("business_id","source_type","source_id") WHERE "status" = 'posted' AND "source_type" IS NOT NULL AND "source_id" IS NOT NULL;
CREATE INDEX "journal_entries_business_date_idx" ON "journal_entries" USING btree ("business_id","entry_date");
CREATE INDEX "journal_entries_business_status_idx" ON "journal_entries" USING btree ("business_id","status");
CREATE INDEX "journal_entries_reversal_of_idx" ON "journal_entries" USING btree ("reversal_of_entry_id");

-- ============ journal_entry_lines ============
CREATE TABLE "journal_entry_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_id" integer NOT NULL,
	"business_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"debit" numeric(14, 2) NOT NULL,
	"credit" numeric(14, 2) NOT NULL,
	"location_id" integer,
	"description" varchar(255),
	CONSTRAINT "journal_entry_lines_amounts_check" CHECK (
		"debit" >= 0 AND "credit" >= 0 AND ("debit" = 0) <> ("credit" = 0)
	)
);
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_entry_business_fkey" FOREIGN KEY ("entry_id","business_id") REFERENCES "journal_entries"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_account_business_fkey" FOREIGN KEY ("account_id","business_id") REFERENCES "chart_of_accounts"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_location_business_fkey" FOREIGN KEY ("location_id","business_id") REFERENCES "locations"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX "journal_entry_lines_entry_idx" ON "journal_entry_lines" USING btree ("entry_id");
CREATE INDEX "journal_entry_lines_business_account_idx" ON "journal_entry_lines" USING btree ("business_id","account_id");
CREATE UNIQUE INDEX "journal_entry_lines_id_business_uq" ON "journal_entry_lines" USING btree ("id","business_id");

-- ============ payment_accounts ============
CREATE TABLE "payment_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"type" "payment_account_type" NOT NULL,
	"provider" varchar(30),
	"gl_account_id" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'BDT' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_reconciled_at" timestamp with time zone,
	"notes" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_gl_account_business_fkey" FOREIGN KEY ("gl_account_id","business_id") REFERENCES "chart_of_accounts"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "payment_accounts_id_business_uq" ON "payment_accounts" USING btree ("id","business_id");
CREATE INDEX "payment_accounts_business_idx" ON "payment_accounts" USING btree ("business_id","type");
-- One default account per (business, type) among active accounts.
CREATE UNIQUE INDEX "payment_accounts_default_per_type_uq" ON "payment_accounts" USING btree ("business_id","type") WHERE "is_default" = true AND "is_active" = true;

-- ============ additive columns on existing tables ============
ALTER TABLE "businesses" ADD COLUMN "ledger_activated_at" timestamp with time zone;

ALTER TABLE "sale_payments" ADD COLUMN "payment_account_id" integer;
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_payment_account_business_fkey" FOREIGN KEY ("payment_account_id","business_id") REFERENCES "payment_accounts"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "expense_payments" ADD COLUMN "payment_account_id" integer;
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_payment_account_business_fkey" FOREIGN KEY ("payment_account_id","business_id") REFERENCES "payment_accounts"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "purchase_payments" ADD COLUMN "payment_account_id" integer;
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_payment_account_business_fkey" FOREIGN KEY ("payment_account_id","business_id") REFERENCES "payment_accounts"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "expense_categories" ADD COLUMN "gl_account_id" integer;
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_gl_account_business_fkey" FOREIGN KEY ("gl_account_id","business_id") REFERENCES "chart_of_accounts"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "registers" ADD COLUMN "payment_account_id" integer;
ALTER TABLE "registers" ADD CONSTRAINT "registers_payment_account_business_fkey" FOREIGN KEY ("payment_account_id","business_id") REFERENCES "payment_accounts"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
