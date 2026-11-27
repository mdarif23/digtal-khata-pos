-- 0089: WB-02 — the `exports` entitlement (Phase 6 of the Flexible Business
-- Operating Model) is now ENFORCED on the exports router. The plan seeds
-- carry the flag, but they upsert with ON CONFLICT (slug) DO NOTHING — so
-- every plan row created before this feature (i.e. all existing
-- deployments) lacks it, and every export endpoint returns 403
-- FEATURE_NOT_IN_PLAN for existing tenants until someone hand-edits the DB.
--
-- Backfill: add `"exports": true` to the features JSONB of the seeded
-- catalog plans (free-trial, starter-monthly, professional-monthly,
-- enterprise-monthly) whenever the key is absent. Custom plans created via
-- the plans editor are left untouched — those omissions are deliberate
-- (the gating is meant to be plan-selective).
--
-- Rollback: remove the key from the same slugs' features JSONB
--   UPDATE subscription_plans SET features = features - 'exports'
--   WHERE slug IN (...);

UPDATE subscription_plans
SET features = jsonb_set(features, '{exports}', 'true'::jsonb, true)
WHERE slug IN (
  'free-trial',
  'starter-monthly',
  'professional-monthly',
  'enterprise-monthly'
)
AND (features->>'exports') IS NULL;
