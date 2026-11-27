-- 0096: Bundle & Combo Builder Phase 1 — admit the 'bundle' promo kind.
--
-- Migration 0070 introduced the pricing_promotions_kind_check listing the
-- kinds the engine supported then (discount | bogo | buy_x_get_y |
-- mix_match | quantity_tier). Phase 1 of the Bundle & Combo Builder adds
-- 'bundle' (fixed package price over an explicit promotion_bundle_components
-- list, migration 0095), so the CHECK is extended in the same
-- drop-and-recreate pattern 0070 itself used.
--
-- Rollback:
--   ALTER TABLE "pricing_promotions" DROP CONSTRAINT "pricing_promotions_kind_check";
--   ALTER TABLE "pricing_promotions" ADD CONSTRAINT "pricing_promotions_kind_check"
--     CHECK ("promo_kind" IN ('discount','bogo','buy_x_get_y','mix_match','quantity_tier'));

ALTER TABLE "pricing_promotions" DROP CONSTRAINT "pricing_promotions_kind_check";--> statement-breakpoint
ALTER TABLE "pricing_promotions" ADD CONSTRAINT "pricing_promotions_kind_check"
  CHECK ("promo_kind" IN ('discount', 'bogo', 'buy_x_get_y', 'mix_match', 'quantity_tier', 'bundle'));
