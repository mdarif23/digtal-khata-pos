-- 0077: Phase 5 — commission reversal uniqueness fix.
-- The full unique (business, sale, user, rule) blocked REVERSAL entries
-- (same sale+user+rule as the original). Replaced by:
--   1. partial unique on the 4 keys WHERE refund_id IS NULL AND status <> 'reversed'
--      → one commission entry per sale+user+rule (idempotent calculation);
--   2. partial unique on (business, sale, user, rule, refund_id) WHERE refund_id IS NOT NULL
--      → one reversal per refund per entry.
-- Rollback: drop the two partial indexes, restore the full unique constraint.

ALTER TABLE "commission_entries" DROP CONSTRAINT IF EXISTS "commission_entries_sale_user_rule_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commission_entries_sale_user_rule_uq"
  ON "commission_entries" ("business_id", "sale_id", "salesperson_user_id", "rule_id")
  WHERE "refund_id" IS NULL AND "status" <> 'reversed';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commission_entries_reversal_uq"
  ON "commission_entries" ("business_id", "sale_id", "salesperson_user_id", "rule_id", "refund_id")
  WHERE "refund_id" IS NOT NULL;
