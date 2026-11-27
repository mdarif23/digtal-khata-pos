-- 0098: Bundle & Combo Builder Phase 4 — promotional campaigns.
--
-- promotion_campaigns organizes promotions into seasonal groups (Eid Offer
-- 2027, Back to School, Ramadan Special — master prompt §3E). A campaign
-- GATES its promotions (inactive/expired/out-of-location campaign = its
-- promotions do not apply) and breaks priority ties between same-priority
-- promotions; it never duplicates pricing logic. pricing_promotions gains a
-- nullable campaign_id — a plain FK with ON DELETE SET NULL because a
-- composite (id, business_id) FK with SET NULL would also null business_id
-- (the price_change_proposals.ruleId precedent, migration 0063).
--
-- Rollback:
--   ALTER TABLE "pricing_promotions" DROP CONSTRAINT "pricing_promotions_campaign_fkey";
--   ALTER TABLE "pricing_promotions" DROP COLUMN "campaign_id";
--   DROP TABLE IF EXISTS "promotion_campaigns";

CREATE TABLE IF NOT EXISTS "promotion_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"starts_at" timestamp(3) with time zone,
	"ends_at" timestamp(3) with time zone,
	"priority" integer DEFAULT 0 NOT NULL,
	"location_id" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "promotion_campaigns" ADD CONSTRAINT "campaign_dates_check" CHECK ("promotion_campaigns"."starts_at" IS NULL OR "promotion_campaigns"."ends_at" IS NULL OR "promotion_campaigns"."starts_at" <= "promotion_campaigns"."ends_at");
--> statement-breakpoint
ALTER TABLE "promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_business_name_unique" UNIQUE("business_id", "name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promotion_campaigns_id_business_uq" ON "promotion_campaigns" USING btree ("id","business_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_campaigns_business_idx" ON "promotion_campaigns" USING btree ("business_id");
--> statement-breakpoint
ALTER TABLE "pricing_promotions" ADD COLUMN IF NOT EXISTS "campaign_id" integer;
--> statement-breakpoint
ALTER TABLE "pricing_promotions" ADD CONSTRAINT "pricing_promotions_campaign_fkey" FOREIGN KEY ("campaign_id") REFERENCES "promotion_campaigns"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pricing_promotions_campaign_idx" ON "pricing_promotions" USING btree ("business_id","campaign_id");
