-- Schema drift fix: the ORM's inventoryBatches schema declares created_at
-- but no earlier migration added it. Needed for batch aging (Module 2D).
ALTER TABLE "inventory_batches" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();
