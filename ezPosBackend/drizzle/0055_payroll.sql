-- 0055: Staff & Payroll (Finance & Growth Stage 5, owner-approved schema).
-- docs/finance-growth/phase-0-audit-and-architecture.md §8 (Phase 3).
--
-- 1) employees — the previously missing staff entity (attendance is
--    user-keyed; employees link to a user when they have one).
-- 2) employee_salary_structures — versioned: one ACTIVE per employee,
--    monthly | daily | hourly pay types with fixed allowances (jsonb).
-- 3) salary_advances — an ASSET (employee owes the business), never an
--    expense; recovered via payroll deductions FIFO.
-- 4) payroll_periods / payroll_records / payroll_payments — monthly
--    processing with duplicate-period-per-employee guards, partial
--    payments and printable payslip data.
--
-- GL treatment (posted at approval / disbursement, sourceTypes 'payroll',
-- 'payroll_advance', 'payroll_payment'):
--   accrual   DR 5020 Salaries & Wages (gross)
--             CR 2030 Salary Payable (net + other withheld deductions)
--             CR 1060 Employee Salary Advances (recovery)
--   advance   DR 1060 / CR cash
--   payment   DR 2030 / CR cash

CREATE TYPE "employee_status" AS ENUM ('active', 'inactive', 'terminated');
CREATE TYPE "salary_pay_type" AS ENUM ('monthly', 'daily', 'hourly');
CREATE TYPE "payroll_period_status" AS ENUM ('draft', 'approved', 'paid', 'partial', 'cancelled');

CREATE TABLE "employees" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"employee_code" varchar(30) NOT NULL,
	"user_id" integer,
	"full_name" varchar(120) NOT NULL,
	"phone" varchar(30),
	"email" varchar(255),
	"address" varchar(255),
	"designation" varchar(100),
	"department" varchar(100),
	"joining_date" date,
	"employment_status" "employee_status" DEFAULT 'active' NOT NULL,
	"location_id" integer,
	"payment_method" varchar(30),
	"notes" varchar(500),
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_business_code_unique" UNIQUE("business_id","employee_code")
);
ALTER TABLE "employees" ADD CONSTRAINT "employees_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "employees" ADD CONSTRAINT "employees_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "employees" ADD CONSTRAINT "employees_location_business_fkey" FOREIGN KEY ("location_id","business_id") REFERENCES "locations"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "employees_id_business_uq" ON "employees" USING btree ("id","business_id");
CREATE INDEX "employees_business_status_idx" ON "employees" USING btree ("business_id","employment_status");

CREATE TABLE "employee_salary_structures" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"employee_id" integer NOT NULL,
	"pay_type" "salary_pay_type" NOT NULL,
	"basic_amount" numeric(14, 2) NOT NULL,
	/** Fixed allowances: [{ name, amount }] — monthly for monthly pay. */
	"allowances" jsonb DEFAULT '[]'::jsonb NOT NULL,
	/** Overtime rate per hour (defaults to the per-hour basic). */
	"overtime_rate" numeric(14, 2),
	"effective_from" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_salary_structures_basic_nonnegative_check" CHECK ("basic_amount" >= 0)
);
ALTER TABLE "employee_salary_structures" ADD CONSTRAINT "employee_salary_structures_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "employee_salary_structures" ADD CONSTRAINT "employee_salary_structures_employee_business_fkey" FOREIGN KEY ("employee_id","business_id") REFERENCES "employees"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "employee_salary_structures" ADD CONSTRAINT "employee_salary_structures_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- Exactly one active structure per employee.
CREATE UNIQUE INDEX "employee_salary_structures_one_active_unique" ON "employee_salary_structures" USING btree ("employee_id") WHERE "is_active" = true;
CREATE INDEX "employee_salary_structures_business_idx" ON "employee_salary_structures" USING btree ("business_id","employee_id");

CREATE TABLE "salary_advances" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"employee_id" integer NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"advance_date" date NOT NULL,
	"outstanding_amount" numeric(14, 2) NOT NULL,
	"reason" varchar(255),
	"journal_entry_id" integer,
	"client_uuid" uuid,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salary_advances_amount_positive_check" CHECK ("amount" > 0 AND "outstanding_amount" >= 0)
);
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_employee_business_fkey" FOREIGN KEY ("employee_id","business_id") REFERENCES "employees"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "salary_advances_client_uuid_unique" ON "salary_advances" USING btree ("client_uuid");
CREATE INDEX "salary_advances_business_employee_idx" ON "salary_advances" USING btree ("business_id","employee_id");

CREATE TABLE "payroll_periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"period_type" varchar(20) DEFAULT 'monthly' NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" "payroll_period_status" DEFAULT 'draft' NOT NULL,
	"gross_total" numeric(14, 2) DEFAULT 0 NOT NULL,
	"net_total" numeric(14, 2) DEFAULT 0 NOT NULL,
	"advance_recovery_total" numeric(14, 2) DEFAULT 0 NOT NULL,
	"approved_by_user_id" integer,
	"approved_at" timestamp with time zone,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_periods_monthly_start_check" CHECK ("period_start" = date_trunc('month', "period_start")::date),
	CONSTRAINT "payroll_periods_range_check" CHECK ("period_end" > "period_start")
);
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- Duplicate-processing guard: one period per month per business.
CREATE UNIQUE INDEX "payroll_periods_business_month_unique" ON "payroll_periods" USING btree ("business_id","period_start");
-- Candidate key for the composite FK from payroll_records.
CREATE UNIQUE INDEX "payroll_periods_id_business_uq" ON "payroll_periods" USING btree ("id","business_id");

CREATE TABLE "payroll_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"period_id" integer NOT NULL,
	"employee_id" integer NOT NULL,
	/** Attendance inputs (worked days may derive from attendance records). */
	"worked_days" integer DEFAULT 0 NOT NULL,
	"absent_days" integer DEFAULT 0 NOT NULL,
	"leave_days" integer DEFAULT 0 NOT NULL,
	"half_days" integer DEFAULT 0 NOT NULL,
	"overtime_hours" numeric(9, 2) DEFAULT 0 NOT NULL,
	"worked_hours" numeric(9, 2),
	"basic_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"allowances_total" numeric(14, 2) DEFAULT 0 NOT NULL,
	"overtime_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"bonus_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"commission_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"other_deductions" numeric(14, 2) DEFAULT 0 NOT NULL,
	"advance_deduction" numeric(14, 2) DEFAULT 0 NOT NULL,
	"gross_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"net_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_records_days_nonnegative_check" CHECK (
		"worked_days" >= 0 AND "absent_days" >= 0 AND "leave_days" >= 0 AND "half_days" >= 0
	)
);
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_period_business_fkey" FOREIGN KEY ("period_id","business_id") REFERENCES "payroll_periods"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_employee_business_fkey" FOREIGN KEY ("employee_id","business_id") REFERENCES "employees"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- Duplicate-processing guard: one record per employee per period.
CREATE UNIQUE INDEX "payroll_records_period_employee_unique" ON "payroll_records" USING btree ("period_id","employee_id");
-- Candidate key for the composite FK from payroll_payments.
CREATE UNIQUE INDEX "payroll_records_id_business_uq" ON "payroll_records" USING btree ("id","business_id");
CREATE INDEX "payroll_records_business_idx" ON "payroll_records" USING btree ("business_id","period_id");

CREATE TABLE "payroll_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"payroll_record_id" integer NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"method" varchar(30),
	"payment_account_id" integer,
	"payment_date" date NOT NULL,
	"reference" varchar(100),
	"journal_entry_id" integer,
	"client_uuid" uuid,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_payments_amount_positive_check" CHECK ("amount" > 0)
);
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_record_business_fkey" FOREIGN KEY ("payroll_record_id","business_id") REFERENCES "payroll_records"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_payment_account_business_fkey" FOREIGN KEY ("payment_account_id","business_id") REFERENCES "payment_accounts"("id","business_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "payroll_payments_client_uuid_unique" ON "payroll_payments" USING btree ("client_uuid");
CREATE INDEX "payroll_payments_record_idx" ON "payroll_payments" USING btree ("payroll_record_id");
