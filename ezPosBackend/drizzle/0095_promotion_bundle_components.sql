-- 0095: Bundle & Combo Builder Phase 1 — fixed bundles.
--
-- Adds the component multiset for the new 'bundle' promo kind on
-- pricing_promotions (Promotion kind: fixed package price over an explicit
-- component list, e.g. 5 notebooks + 3 pens + 2 pencils + 1 eraser = ৳299).
-- Components live in this child table (queryable + FK-enforced) while the
-- bundle's price configuration stays in pricing_promotions.rule jsonb:
--   { bundlePrice }            → fixed special price for the whole package
--   { discountPercent }        → percent off the covered component total
--   { maxApplications? }       → cap on how many complete bundles apply per cart
--
-- Conventions follow promotion_customer_groups: composite FKs carrying
-- business_id (unlike bom_components, component variants are FK-enforced so
-- a component cannot be orphaned), cascade on promotion delete, and the
-- (id, business_id) tenant unique. Scope columns on the parent promotion
-- stay NULL for bundles — the component list IS the scope.
--
-- Rollback:
--   DROP TABLE IF EXISTS "promotion_bundle_components";

CREATE TABLE IF NOT EXISTS "promotion_bundle_components" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"promotion_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promotion_bundle_components" ADD CONSTRAINT "pbc_quantity_check" CHECK ("promotion_bundle_components"."quantity" > 0);
--> statement-breakpoint
ALTER TABLE "promotion_bundle_components" ADD CONSTRAINT "pbc_promotion_business_fkey" FOREIGN KEY ("promotion_id","business_id") REFERENCES "pricing_promotions"("id","business_id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "promotion_bundle_components" ADD CONSTRAINT "pbc_variant_business_fkey" FOREIGN KEY ("variant_id","business_id") REFERENCES "product_variants"("id","business_id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pbc_id_business_uq" ON "promotion_bundle_components" USING btree ("id","business_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pbc_promotion_variant_uq" ON "promotion_bundle_components" USING btree ("promotion_id","variant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pbc_promotion_idx" ON "promotion_bundle_components" USING btree ("promotion_id");
