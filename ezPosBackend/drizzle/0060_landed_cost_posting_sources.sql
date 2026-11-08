-- 0060: posting source attribution (Phase 9, owner-approved plan):
-- landed_cost_postings.expense_id links each per-expense posting
-- (capitalization / period expense) back to the landed_cost_expenses row
-- it was derived from — the Phase 4 source identity becomes traceable
-- end-to-end. NULL = legacy rows and event-level postings
-- (cogs_adjustment / reversal), which are document-level by nature.
-- Additive only: no existing column semantics change, no data migration.
ALTER TABLE "landed_cost_postings" ADD COLUMN "expense_id" integer;

-- Composite-FK pattern (same as landed_cost_postings_id_business_uq /
-- landed_cost_adjustments_id_business_uq): a unique (id, business_id) on
-- the target table lets the new FK enforce tenancy, not just identity.
CREATE UNIQUE INDEX IF NOT EXISTS "landed_cost_expenses_id_business_uq"
  ON "landed_cost_expenses" ("id", "business_id");

ALTER TABLE "landed_cost_postings" ADD CONSTRAINT "landed_cost_postings_expense_business_fkey"
  FOREIGN KEY ("expense_id", "business_id")
  REFERENCES "landed_cost_expenses" ("id", "business_id") ON DELETE NO ACTION;
