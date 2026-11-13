-- 0073: Phase 4 — sale/movement precision (Feature 10 completion).
-- sale_items.quantity and inventory_movements.quantity become numeric(14,4)
-- so sold_by_weight lines record fractional amounts exactly. Integer
-- callers keep working (numeric accepts integer input; reads are
-- number-typed through drizzle).
-- Rollback: ALTER COLUMN TYPE integer (fails while fractional rows exist).

ALTER TABLE "sale_items" ALTER COLUMN "quantity" TYPE numeric(14, 4);
--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "quantity" TYPE numeric(14, 4);
