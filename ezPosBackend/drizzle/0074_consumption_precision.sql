-- 0074: Phase 4 — batch consumption precision (Feature 10 completion).
-- sale_item_batch_consumptions.quantity becomes numeric(14,4) so weight
-- variants persist fractional batch draws exactly.
-- Rollback: ALTER COLUMN TYPE integer (fails while fractional rows exist).

ALTER TABLE "sale_item_batch_consumptions" ALTER COLUMN "quantity" TYPE numeric(14, 4);
