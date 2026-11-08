// ============================================================================
// SUBSCRIPTION-PLAN SEED (cross-platform replacement for the psql seeds)
// ============================================================================
// A fresh database ships with ZERO subscription plans, which silently breaks
// the product: business creation skips the trial ("no active plan record")
// and every write then 403s with SUBSCRIPTION_REQUIRED. This script inserts
// the plan catalog idempotently (matches scripts/seed-trial-plan.sql +
// scripts/seed-example-plans.sql) and backfills trials for businesses that
// predate the seed.
//
// Usage:  npm run db:seed          (or: npx tsx scripts/seed-plans.ts)
// Requires DATABASE_URL in .env. Safe to run repeatedly.
// ============================================================================
import "dotenv/config";
import { pool } from "../src/config/db.js";

const TRIAL_PLAN = {
  name: "Free trial",
  slug: "free-trial",
  description: "Everything you need to try ezPos for 14 days.",
  interval: "monthly",
  price: 0,
  limits: {
    maxUsers: 3,
    maxLocations: 1,
    maxProducts: 100,
    maxConnectedStores: 1,
    maxWebhookEndpoints: 1,
  },
  features: {
    storefrontApi: true,
    woocommerceIntegration: true,
    customStorefront: true,
    multipleOnlineStores: false,
    advancedWebhooks: true,
  },
  trialDays: 14,
  isPopular: false,
  sortOrder: 0,
  supportLevel: "email",
};

const CATALOG = [
  {
    name: "Starter",
    slug: "starter-monthly",
    description:
      "For small shops getting started: fast billing, inventory, and essential reports.",
    price: 700,
    limits: {
      maxUsers: 2,
      maxLocations: 1,
      maxProducts: 300,
      maxConnectedStores: 1,
      maxWebhookEndpoints: 1,
    },
    features: { storefrontApi: true, woocommerceIntegration: true },
    isPopular: false,
    sortOrder: 10,
    supportLevel: "email",
  },
  {
    name: "Professional",
    slug: "professional-monthly",
    description:
      "For growing businesses: multi-location stock, purchases, and advanced reports.",
    price: 1500,
    limits: {
      maxUsers: 8,
      maxLocations: 3,
      maxProducts: 5000,
      maxConnectedStores: 2,
      maxWebhookEndpoints: 3,
    },
    features: {
      multiLocation: true,
      advancedReports: true,
      purchaseManagement: true,
      storefrontApi: true,
      woocommerceIntegration: true,
      customStorefront: true,
      multipleOnlineStores: true,
      advancedWebhooks: true,
    },
    isPopular: true,
    sortOrder: 20,
    supportLevel: "priority email",
  },
  {
    name: "Enterprise",
    slug: "enterprise-monthly",
    description:
      "For multi-outlet operations: unlimited scale, advanced permissions, and priority support.",
    price: 3000,
    limits: {},
    features: {
      multiLocation: true,
      advancedReports: true,
      purchaseManagement: true,
      exports: true,
      storefrontApi: true,
      woocommerceIntegration: true,
      customStorefront: true,
      multipleOnlineStores: true,
      advancedWebhooks: true,
    },
    isPopular: false,
    sortOrder: 30,
    supportLevel: "priority",
  },
];

async function upsertPlans(): Promise<void> {
  for (const plan of [TRIAL_PLAN, ...CATALOG]) {
    const result = await pool.query(
      `INSERT INTO subscription_plans
         (name, slug, description, interval, price, currency, limits, features,
          trial_days, is_popular, sort_order, support_level, is_active)
       VALUES ($1, $2, $3, 'monthly', $4, 'BDT', $5::jsonb, $6::jsonb,
               $7, $8, $9, $10, true)
       ON CONFLICT (slug) DO NOTHING
       RETURNING (xmax = 0) AS inserted`,
      [
        plan.name,
        plan.slug,
        plan.description,
        plan.price,
        JSON.stringify(plan.limits),
        JSON.stringify(plan.features),
        TRIAL_PLAN.trialDays,
        plan.isPopular,
        plan.sortOrder,
        plan.supportLevel,
      ],
    );
    console.log(
      `  ${result.rows[0]?.inserted ? "created" : "already present"}: ${plan.name} (${plan.slug})`,
    );
  }
}

async function backfillTrials(): Promise<number> {
  // Every business with no open subscription gets a 14-day trial — the
  // partial unique index subscriptions_one_open_per_business keeps this
  // idempotent, the NOT EXISTS guard prevents duplicate rows.
  const result = await pool.query(
    `INSERT INTO subscriptions
       (business_id, plan_id, status, starts_at, current_period_start, current_period_end)
     SELECT b.id, p.id, 'trialing', now(), now(), now() + make_interval(days => $1)
     FROM businesses b
     CROSS JOIN (
       SELECT id FROM subscription_plans
       WHERE slug = $2 AND is_active = true
     ) p
     WHERE NOT EXISTS (
       SELECT 1 FROM subscriptions s
       WHERE s.business_id = b.id
         AND s.status IN ('trialing', 'active', 'past_due')
     )`,
    [TRIAL_PLAN.trialDays, TRIAL_PLAN.slug],
  );
  return result.rowCount ?? 0;
}

async function main(): Promise<void> {
  console.log("Seeding subscription plans…");
  await upsertPlans();
  const trials = await backfillTrials();
  console.log(
    trials > 0
      ? `Backfilled ${trials} trial subscription(s) for businesses without one.`
      : "No businesses needed a trial backfill.",
  );
  const { rows } = await pool.query(
    `SELECT slug, price, is_active FROM subscription_plans ORDER BY sort_order`,
  );
  console.log(
    "Plan catalog now:",
    rows.map((r) => `${r.slug}(${r.price} BDT${r.is_active ? "" : ", INACTIVE"})`).join(", "),
  );
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("Seed failed:", err.message);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
