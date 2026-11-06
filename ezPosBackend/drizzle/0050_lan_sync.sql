-- LAN server mode (multi-terminal Phase 2): the sync-agent identity on the
-- cloud, the local server's durable outbox bookkeeping on sales, stable
-- cross-server customer identity, and the catalog watermarks the delta
-- pull needs. Everything here is additive and inert on a cloud-only
-- deployment — the sync agent only runs when EZPOS_SYNC_ENABLED=true.

-- 1. The LAN server pairs as a special terminal. At most ONE sync agent
-- per business+location: a second accidentally-started local server for
-- the same shop cannot ever register as an agent (the DB refuses), so two
-- local servers can never become competing inventory authorities.
ALTER TABLE "pos_terminals" ADD COLUMN "is_sync_agent" boolean NOT NULL DEFAULT false;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_terminals_one_sync_agent_per_location"
  ON "pos_terminals" ("business_id", "location_id")
  WHERE "is_sync_agent" = true;--> statement-breakpoint

-- 2. The local server's durable outbox IS the committed sales table:
-- synced_at IS NULL means "not yet uploaded". attempts caps poison ops
-- (dead-letter by attempt count; the row is never deleted).
ALTER TABLE "sales" ADD COLUMN "synced_at" timestamptz;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "sync_attempts" integer NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE INDEX "sales_unsynced_idx"
  ON "sales" ("business_id", "id")
  WHERE "synced_at" IS NULL AND "channel" = 'pos' AND "status" = 'completed';--> statement-breakpoint

-- 3. Stable customer identity across servers: the LAN server generates a
-- UUID per customer; the cloud adopts the same UUID, so a customer created
-- offline maps to exactly one cloud row.
ALTER TABLE "customers" ADD COLUMN "client_uuid" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_business_client_uuid_uq"
  ON "customers" ("business_id", "client_uuid")
  WHERE "client_uuid" IS NOT NULL;--> statement-breakpoint

-- 4. Local sync bookkeeping (inert on the cloud): per-stream pull cursors
-- and the local→cloud id map for customers adopted by the cloud.
CREATE TABLE "sync_state" (
  "stream" varchar(50) PRIMARY KEY,
  "cursor" text,
  "last_push_at" timestamptz,
  "last_pull_at" timestamptz,
  "last_error" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE "sync_id_map" (
  "business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "kind" varchar(50) NOT NULL,
  "local_id" integer NOT NULL,
  "remote_id" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("business_id", "kind", "local_id")
);--> statement-breakpoint

-- 5. Catalog watermarks: product_variants and variant_barcode_aliases had
-- no updated_at; add the column plus row triggers so ANY update path (ORM
-- or SQL) advances the watermark. products/customers already carry
-- updated_at but nothing maintained them — trigger them too.
ALTER TABLE "product_variants" ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "variant_barcode_aliases" ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ezpos_touch_updated_at"() RETURNS trigger AS $$
BEGIN
  NEW."updated_at" = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "product_variants_touch_updated_at"
  BEFORE UPDATE ON "product_variants"
  FOR EACH ROW EXECUTE FUNCTION "ezpos_touch_updated_at"();--> statement-breakpoint
CREATE OR REPLACE TRIGGER "variant_barcode_aliases_touch_updated_at"
  BEFORE UPDATE ON "variant_barcode_aliases"
  FOR EACH ROW EXECUTE FUNCTION "ezpos_touch_updated_at"();--> statement-breakpoint
CREATE OR REPLACE TRIGGER "products_touch_updated_at"
  BEFORE UPDATE ON "products"
  FOR EACH ROW EXECUTE FUNCTION "ezpos_touch_updated_at"();--> statement-breakpoint
CREATE OR REPLACE TRIGGER "customers_touch_updated_at"
  BEFORE UPDATE ON "customers"
  FOR EACH ROW EXECUTE FUNCTION "ezpos_touch_updated_at"();--> statement-breakpoint

-- 6. Sales replicated from a LAN server carry the 'offline' channel so
-- cloud reports can distinguish (and aggregate) them from cloud POS sales.
ALTER TYPE "sale_channel" ADD VALUE IF NOT EXISTS 'offline' AFTER 'custom_storefront';
