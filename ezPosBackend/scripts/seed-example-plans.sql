-- ============================================================================
-- EXAMPLE SUBSCRIPTION-PLAN SEED (Phase 2 — SaaS subscription core)
-- ============================================================================
-- Seeds the initial public catalog: Starter / Professional / Enterprise.
-- These are STARTING POINTS — every field is editable through the SaaS admin
-- API (PATCH /api/saas/plans/:id, platform admin only) and, from Phase 6,
-- the admin UI. Run once against the target database; idempotent via slug.
--
-- Feature flags (features jsonb, enforced server-side):
--   multiLocation    — inter-location transfers + >1 location
--   advancedReports  — profit, tax reconciliation, location comparison
--   exports / purchaseManagement — reserved for later phases
-- ============================================================================

INSERT INTO subscription_plans
  (name, slug, description, interval, price, currency, limits, features, trial_days, is_popular, sort_order, support_level, is_active)
VALUES
  ('Starter', 'starter-monthly',
   'For small shops getting started: fast billing, inventory, and essential reports.',
   'monthly', 700, 'BDT',
   '{"maxUsers":2,"maxLocations":1,"maxProducts":300,"maxConnectedStores":1,"maxWebhookEndpoints":1}'::jsonb,
   '{"storefrontApi":true,"woocommerceIntegration":true}'::jsonb,
   14, false, 10, 'email', true),
  ('Professional', 'professional-monthly',
   'For growing businesses: multi-location stock, purchases, and advanced reports.',
   'monthly', 1500, 'BDT',
   '{"maxUsers":8,"maxLocations":3,"maxProducts":5000,"maxConnectedStores":2,"maxWebhookEndpoints":3}'::jsonb,
   '{"multiLocation":true,"advancedReports":true,"purchaseManagement":true,"storefrontApi":true,"woocommerceIntegration":true,"customStorefront":true,"multipleOnlineStores":true,"advancedWebhooks":true}'::jsonb,
   14, true, 20, 'priority email', true),
  ('Enterprise', 'enterprise-monthly',
   'For multi-outlet operations: unlimited scale, advanced permissions, and priority support.',
   'monthly', 3000, 'BDT',
   '{}'::jsonb,
   '{"multiLocation":true,"advancedReports":true,"purchaseManagement":true,"exports":true,"storefrontApi":true,"woocommerceIntegration":true,"customStorefront":true,"multipleOnlineStores":true,"advancedWebhooks":true}'::jsonb,
   14, false, 30, 'priority', true)
ON CONFLICT (slug) DO NOTHING;
