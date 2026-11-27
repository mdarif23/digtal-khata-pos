-- 0097: Bundle & Combo Builder Phase 3 — spend-qualified rewards.
--
-- Adds the 'spend_get' promo kind: "buy products worth ৳X, get a selected
-- product free / at a percent / at a fixed price" (master prompt §3F).
-- Qualification is the post-group cart total (engine-priced), repetitions
-- = floor(total / spendAmount) capped by rule.maxApplications; the reward
-- targets live in pricing_promotions.rule — the parent's scope columns stay
-- NULL (validated at write time), exactly like the 'bundle' kind.
--
-- Rollback:
--   ALTER TABLE "pricing_promotions" DROP CONSTRAINT "pricing_promotions_kind_check";
--   ALTER TABLE "pricing_promotions" ADD CONSTRAINT "pricing_promotions_kind_check"
--     CHECK ("promo_kind" IN ('discount','bogo','buy_x_get_y','mix_match','quantity_tier','bundle'));

ALTER TABLE "pricing_promotions" DROP CONSTRAINT "pricing_promotions_kind_check";--> statement-breakpoint
ALTER TABLE "pricing_promotions" ADD CONSTRAINT "pricing_promotions_kind_check"
  CHECK ("promo_kind" IN ('discount', 'bogo', 'buy_x_get_y', 'mix_match', 'quantity_tier', 'bundle', 'spend_get'));
