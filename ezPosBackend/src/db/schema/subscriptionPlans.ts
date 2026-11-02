import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { billingIntervalEnum } from "./saasEnums.js";

/**
 * Entitlement flags a plan can carry. Absent/false means the plan does not
 * include the capability; enforced server-side in middleware/entitlements.ts
 * and src/services/entitlements.ts — never by hiding frontend buttons alone.
 */
export interface PlanFeatures {
  /** Inter-location stock transfers and more than one location. */
  multiLocation?: boolean | undefined;
  /** Profit, tax reconciliation, and location-comparison reports. */
  advancedReports?: boolean | undefined;
  /** Data export endpoints (reserved; no gate wired yet). */
  exports?: boolean | undefined;
  /** Purchase management module (reserved; no gate wired yet). */
  purchaseManagement?: boolean | undefined;
  /** Storefront API keys for custom websites (Phase 9.2). */
  storefrontApi?: boolean | undefined;
  /** WooCommerce store connections (Phase 9.3). */
  woocommerceIntegration?: boolean | undefined;
  /** More than one connected store of any platform. */
  multipleOnlineStores?: boolean | undefined;
  /** Outbound webhook endpoints (Phase 9.4). */
  advancedWebhooks?: boolean | undefined;
  /** Hosted storefront builder sites (website platform stage 1). */
  hostedStorefront?: boolean | undefined;
  /** Connecting custom domains to hosted storefronts. */
  storefrontCustomDomains?: boolean | undefined;
  /** Premium (non-core) storefront templates. */
  premiumThemes?: boolean | undefined;
  /** Storefront analytics dashboard. */
  storefrontAnalytics?: boolean | undefined;
}

export interface PlanLimits {
  maxUsers?: number | undefined;
  maxLocations?: number | undefined;
  maxProducts?: number | undefined;
  /** Connected storefront integrations (all platforms). */
  maxConnectedStores?: number | undefined;
  /** Registered outbound webhook endpoints. */
  maxWebhookEndpoints?: number | undefined;
  /** Hosted storefronts the business may create. */
  maxStorefronts?: number | undefined;
  /** Custom domains across the business's storefronts. */
  maxCustomDomains?: number | undefined;
  /** Object-storage quota for storefront media, in megabytes. */
  maxMediaStorageMb?: number | undefined;
}

export const subscriptionPlans = pgTable("subscription_plans", {
  id: serial().primaryKey().notNull(),
  name: varchar({ length: 100 }).notNull(),
  slug: varchar({ length: 50 }).notNull().unique(),
  description: varchar({ length: 500 }),
  interval: billingIntervalEnum("interval").notNull(),
  price: numeric({ precision: 10, scale: 2, mode: "number" }).notNull(),
  currency: varchar({ length: 3 }).default("BDT").notNull(),
  limits: jsonb().$type<PlanLimits>(),
  features: jsonb().$type<PlanFeatures>(),
  trialDays: integer("trial_days"),
  isPopular: boolean("is_popular").default(false).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  supportLevel: varchar("support_level", { length: 30 }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
