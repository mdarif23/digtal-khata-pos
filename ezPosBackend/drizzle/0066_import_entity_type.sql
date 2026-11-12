-- 0066: Phase 1 import generalization (approved audit report §5).
-- The product-import session machinery (0047) becomes reusable for
-- customers/suppliers onboarding imports: an entity_type discriminator on
-- the shared session/row tables, and the one-running-session guard becomes
-- per business + entity so a customer import can run while a product import
-- runs. IDEMPOTENT; rollback = DROP COLUMN + recreate the old index.

ALTER TABLE "product_import_sessions"
  ADD COLUMN IF NOT EXISTS "entity_type" varchar(20) NOT NULL DEFAULT 'products';
--> statement-breakpoint

-- One running import per business PER ENTITY (was: per business outright).
DROP INDEX IF EXISTS "product_import_sessions_one_running_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_import_sessions_one_running_uq"
  ON "product_import_sessions" USING btree ("business_id", "entity_type")
  WHERE status = 'running';
