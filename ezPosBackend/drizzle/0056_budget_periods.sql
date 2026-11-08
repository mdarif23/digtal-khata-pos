-- 0056: Budget period types + threshold alerts (Finance & Growth Stage 7,
-- Phase 6, owner-approved schema). Extends the EXISTING expense_budgets
-- module (approved decision: one budget system, backward-compatible).
--
-- period_type: monthly (default, unchanged behavior) | quarterly | yearly.
--   `month` stores the PERIOD START (month / quarter / year start).
-- warning_threshold_percent: the utilization % that triggers a
--   budget_alert notification (checked on read + by the scheduler sweep).

ALTER TABLE "expense_budgets" ADD COLUMN "period_type" varchar(20) DEFAULT 'monthly' NOT NULL;
ALTER TABLE "expense_budgets" ADD COLUMN "warning_threshold_percent" numeric(5, 2) DEFAULT 80 NOT NULL;

-- The monthly-only check becomes period-aware.
ALTER TABLE "expense_budgets" DROP CONSTRAINT "expense_budgets_month_check";
ALTER TABLE "expense_budgets" ADD CONSTRAINT "expense_budgets_period_check" CHECK (
	("period_type" = 'monthly' AND "month" = date_trunc('month', "month")::date)
	OR ("period_type" = 'quarterly' AND "month" = date_trunc('quarter', "month")::date)
	OR ("period_type" = 'yearly' AND "month" = date_trunc('year', "month")::date)
);

-- Scope uniqueness now includes the period type so a monthly January and a
-- quarterly Q1 budget can coexist for the same scope.
DROP INDEX IF EXISTS "expense_budgets_scope_month_unique";
CREATE UNIQUE INDEX "expense_budgets_scope_period_unique" ON "expense_budgets"
USING btree ("business_id", "period_type", coalesce("category_id", 0), coalesce("location_id", 0), "month");

ALTER TABLE "expense_budgets" ADD CONSTRAINT "expense_budgets_warning_threshold_check" CHECK (
	"warning_threshold_percent" > 0 AND "warning_threshold_percent" <= 100
);
