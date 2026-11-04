import { execSync } from "node:child_process";

// The free-trial plan row is NOT part of migrations — the integration suites
// seed it themselves (tenancy.integration.test.ts) and so must E2E: without
// it, every new business gets 403 SUBSCRIPTION_REQUIRED on writes.
const DB_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres@localhost:5433/ezpos_test";

const SQL = `INSERT INTO subscription_plans (name, slug, interval, price, currency, is_active)
  VALUES ('Free trial', 'free-trial', 'monthly', 0, 'BDT', true)
  ON CONFLICT (slug) DO UPDATE
  SET limits = NULL,
      features = '{"multiLocation":true,"advancedReports":true,"storefrontApi":true,"woocommerceIntegration":true,"customStorefront":true,"multipleOnlineStores":true,"advancedWebhooks":true}'::jsonb,
      is_active = true`;

export default function globalSetup(): void {
  execSync(`psql "${DB_URL}" -v ON_ERROR_STOP=1`, { input: SQL });
}
