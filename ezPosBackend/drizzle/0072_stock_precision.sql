-- 0072: Phase 4 — stock precision for weight selling (Feature 10).
-- Stock quantities become numeric(14,4) so sold_by_weight variants can hold
-- and move fractional amounts. Integers fit unchanged; every consumer reads
-- through number-typed columns. Offline allocation grants remain integer and
-- skip sold_by_weight variants (enforced in code — the allocation ledger is
-- a per-terminal integer budget).
-- Rollback: ALTER COLUMN TYPE integer (fails while fractional rows exist).

ALTER TABLE "inventory_stock" ALTER COLUMN "quantity" TYPE numeric(14, 4);
--> statement-breakpoint
ALTER TABLE "inventory_stock" ALTER COLUMN "reserved_quantity" TYPE numeric(14, 4);
--> statement-breakpoint
ALTER TABLE "inventory_batches" ALTER COLUMN "quantity_received" TYPE numeric(14, 4);
--> statement-breakpoint
ALTER TABLE "inventory_batches" ALTER COLUMN "quantity_remaining" TYPE numeric(14, 4);
