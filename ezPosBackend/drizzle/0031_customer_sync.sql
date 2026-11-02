-- Customer synchronization (Module 12, Phase 6). Outbound push of ezPos
-- customers to WooCommerce integrations (upsert by email), driven by the
-- scheduler with a per-integration watermark. Inbound (order-import)
-- customer resolution already exists; matched records now backfill
-- missing contact details. updated_at drives the watermark.
ALTER TABLE "customers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "customer_sync_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "customer_synced_at" timestamp with time zone;
