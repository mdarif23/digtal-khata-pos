-- 0053: Landed-cost expense source identity (owner-approved).
-- 'purchase' rows mirror a purchase financial record (source_key
-- 'shipping_cost' → purchases.shipping_cost; the amount is a snapshot of
-- it) and are server-generated — they bring no new payable and no
-- duplicate expense. 'additional_expense' rows are user-entered (all
-- pre-0053 rows). The partial unique index makes the same purchase-origin
-- source impossible twice per document; documents are unique per
-- purchase, so once per purchase.

CREATE TYPE "landed_cost_expense_source_enum" AS ENUM
  ('purchase', 'additional_expense');

ALTER TABLE "landed_cost_expenses"
  ADD COLUMN "source_type" "landed_cost_expense_source_enum"
    NOT NULL DEFAULT 'additional_expense',
  ADD COLUMN "source_key" varchar(50);

ALTER TABLE "landed_cost_expenses" ADD CONSTRAINT
  "landed_cost_expenses_source_check" CHECK (
    source_type <> 'purchase' OR source_key IS NOT NULL
  );

CREATE UNIQUE INDEX "landed_cost_expenses_source_uq"
  ON "landed_cost_expenses" ("landed_cost_id", "source_key")
  WHERE source_type = 'purchase';
