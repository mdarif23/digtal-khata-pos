-- 0075: Phase 4 — stock precision as float8 (Feature 10 refinement).
-- numeric(14,4) (0072-0074) returns NUMERIC STRINGS from raw pg queries,
-- which broke every test/service that reads quantities via raw SQL
-- ('3.0000' !== 3). Quantities are never currency — double precision
-- (float8) keeps fractional weight precision AND round-trips as a JS
-- number natively through the pg driver.
-- Rollback: ALTER COLUMN TYPE numeric(14,4) / integer.

ALTER TABLE "inventory_stock" ALTER COLUMN "quantity" TYPE double precision;
--> statement-breakpoint
ALTER TABLE "inventory_stock" ALTER COLUMN "reserved_quantity" TYPE double precision;
--> statement-breakpoint
ALTER TABLE "inventory_batches" ALTER COLUMN "quantity_received" TYPE double precision;
--> statement-breakpoint
ALTER TABLE "inventory_batches" ALTER COLUMN "quantity_remaining" TYPE double precision;
--> statement-breakpoint
ALTER TABLE "sale_items" ALTER COLUMN "quantity" TYPE double precision;
--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "quantity" TYPE double precision;
--> statement-breakpoint
ALTER TABLE "sale_item_batch_consumptions" ALTER COLUMN "quantity" TYPE double precision;
