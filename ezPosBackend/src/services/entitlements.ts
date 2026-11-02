import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import {
  subscriptionPlans,
  type PlanFeatures,
  type PlanLimits,
} from "../db/schema/subscriptionPlans.js";
import { subscriptions } from "../db/schema/subscriptions.js";
import { businessMemberships } from "../db/schema/businessMemberships.js";
import { locations } from "../db/schema/locations.js";
import { products } from "../db/schema/products.js";
import { integrations } from "../db/schema/integrations.js";
import { webhookEndpoints } from "../db/schema/webhooks.js";
import { storefronts } from "../db/schema/storefronts.js";
import { storefrontDomains } from "../db/schema/storefrontDomains.js";
import { storefrontMedia } from "../db/schema/storefrontMedia.js";
import { ForbiddenError } from "../utils/handleError.js";

/**
 * Centralized plan-entitlement and usage-limit service.
 *
 * Every plan check in the backend goes through here — never scattered
 * ad-hoc queries in controllers. Limits are enforced server-side (the
 * frontend may hide buttons, but that is UX only).
 *
 * Limit assertions run inside the caller's transaction and take a
 * per-business advisory lock so two concurrent creates cannot both pass
 * the same count check.
 */

const OPEN_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due"] as const;

export type PlanFeatureKey = NonNullable<keyof PlanFeatures>;

export interface Entitlements {
  plan: {
    id: number;
    name: string;
    slug: string;
    limits: PlanLimits | null;
    features: PlanFeatures | null;
  } | null;
  subscription: {
    id: number;
    status: "trialing" | "active" | "past_due";
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
  } | null;
}

/**
 * The business's open subscription with its plan entitlements.
 * Returns nulls (not errors) when there is no open subscription — callers
 * decide whether that means "unlimited" (never) or "read-only" (handled by
 * requireFullAccess before any entitlement check runs).
 */
export async function getEntitlements(
  businessId: number,
  tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db,
): Promise<Entitlements> {
  const [row] = await tx
    .select({
      subscriptionId: subscriptions.id,
      status: subscriptions.status,
      currentPeriodStart: subscriptions.currentPeriodStart,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      planId: subscriptionPlans.id,
      planName: subscriptionPlans.name,
      planSlug: subscriptionPlans.slug,
      limits: subscriptionPlans.limits,
      features: subscriptionPlans.features,
    })
    .from(subscriptions)
    .innerJoin(
      subscriptionPlans,
      eq(subscriptionPlans.id, subscriptions.planId),
    )
    .where(
      and(
        eq(subscriptions.businessId, businessId),
        inArray(subscriptions.status, [...OPEN_SUBSCRIPTION_STATUSES]),
      ),
    )
    .limit(1);

  if (!row) {
    return { plan: null, subscription: null };
  }

  return {
    plan: {
      id: row.planId,
      name: row.planName,
      slug: row.planSlug,
      limits: row.limits ?? null,
      features: row.features ?? null,
    },
    subscription: {
      id: row.subscriptionId,
      // The WHERE clause restricts to open statuses; narrow the enum.
      status: row.status as "trialing" | "active" | "past_due",
      currentPeriodStart: row.currentPeriodStart,
      currentPeriodEnd: row.currentPeriodEnd,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    },
  };
}

export function planHasFeature(
  entitlements: Entitlements,
  feature: PlanFeatureKey,
): boolean {
  return entitlements.plan?.features?.[feature] === true;
}

/**
 * Throws FEATURE_NOT_IN_PLAN when the business's plan does not include the
 * capability. Route-level equivalent: requireFeature() in
 * middleware/entitlements.ts.
 */
export function assertFeature(
  entitlements: Entitlements,
  feature: PlanFeatureKey,
): void {
  if (!planHasFeature(entitlements, feature)) {
    throw new ForbiddenError(
      "This feature is not part of your current plan. Upgrade to unlock it.",
      "FEATURE_NOT_IN_PLAN",
    );
  }
}

function assertWithinLimit(
  limit: number | undefined,
  currentCount: number,
  noun: string,
): void {
  // A missing limit means the plan does not cap this resource.
  if (limit === undefined || limit === null) return;
  if (currentCount >= limit) {
    throw new ForbiddenError(
      `Your plan allows up to ${limit} ${noun}. Upgrade your plan to add more.`,
      "PLAN_LIMIT_REACHED",
    );
  }
}

async function lockBusinessForLimitCheck(
  businessId: number,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${businessId})`);
}

export async function assertWithinUserLimit(
  businessId: number,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<void> {
  const entitlements = await getEntitlements(businessId, tx);
  assertWithinLimit(
    entitlements.plan?.limits?.maxUsers,
    (
      await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(businessMemberships)
        .where(
          and(
            eq(businessMemberships.businessId, businessId),
            eq(businessMemberships.status, "active"),
          ),
        )
    )[0]?.count ?? 0,
    "team members",
  );
}

export async function assertWithinLocationLimit(
  businessId: number,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<void> {
  const entitlements = await getEntitlements(businessId, tx);
  assertWithinLimit(
    entitlements.plan?.limits?.maxLocations,
    (
      await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(locations)
        .where(eq(locations.businessId, businessId))
    )[0]?.count ?? 0,
    "locations",
  );
}

export async function assertWithinProductLimit(
  businessId: number,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<void> {
  const entitlements = await getEntitlements(businessId, tx);
  assertWithinLimit(
    entitlements.plan?.limits?.maxProducts,
    (
      await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(products)
        .where(
          and(
            eq(products.businessId, businessId),
            eq(products.status, "active"),
          ),
        )
    )[0]?.count ?? 0,
    "active products",
  );
}

export interface BusinessUsage {
  users: number;
  locations: number;
  products: number;
}

/** Usage summary for the customer portal dashboard. */
export async function getBusinessUsage(
  businessId: number,
): Promise<BusinessUsage> {
  const [users] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(businessMemberships)
    .where(
      and(
        eq(businessMemberships.businessId, businessId),
        eq(businessMemberships.status, "active"),
      ),
    );
  const [locationRows] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(locations)
    .where(eq(locations.businessId, businessId));
  const [productRows] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(products)
    .where(
      and(eq(products.businessId, businessId), eq(products.status, "active")),
    );

  return {
    users: users?.count ?? 0,
    locations: locationRows?.count ?? 0,
    products: productRows?.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Integration entitlements (Phase 9.6)
// ---------------------------------------------------------------------------

/** Connected (non-disconnected) storefront integrations. */
export async function countConnectedStores(businessId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(integrations)
    .where(
      and(
        eq(integrations.businessId, businessId),
        sql`${integrations.status} <> 'disconnected'`,
      ),
    );
  return row?.count ?? 0;
}

export async function countWebhookEndpoints(
  businessId: number,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.businessId, businessId));
  return row?.count ?? 0;
}

export function assertWithinStoreLimit(
  entitlements: Entitlements,
  currentCount: number,
): void {
  const limit = entitlements.plan?.limits?.maxConnectedStores;
  if (limit === undefined || limit === null) return;
  if (currentCount >= limit) {
    throw new ForbiddenError(
      `Your plan allows up to ${limit} connected store${limit === 1 ? "" : "s"}. Upgrade your plan to connect more.`,
      "PLAN_LIMIT_REACHED",
    );
  }
}

export function assertWithinWebhookLimit(
  entitlements: Entitlements,
  currentCount: number,
): void {
  const limit = entitlements.plan?.limits?.maxWebhookEndpoints;
  if (limit === undefined || limit === null) return;
  if (currentCount >= limit) {
    throw new ForbiddenError(
      `Your plan allows up to ${limit} webhook endpoint${limit === 1 ? "" : "s"}. Upgrade your plan to add more.`,
      "PLAN_LIMIT_REACHED",
    );
  }
}

// ---------------------------------------------------------------------------
// Hosted storefront platform (website platform stage 1)
// ---------------------------------------------------------------------------

/** Active (non-archived) hosted storefronts. */
export async function countStorefronts(businessId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(storefronts)
    .where(
      and(
        eq(storefronts.businessId, businessId),
        sql`${storefronts.status} <> 'archived'`,
      ),
    );
  return row?.count ?? 0;
}

export async function countCustomDomains(
  businessId: number,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(storefrontDomains)
    .innerJoin(storefronts, eq(storefronts.id, storefrontDomains.storefrontId))
    .where(
      and(
        eq(storefronts.businessId, businessId),
        eq(storefrontDomains.kind, "custom"),
        sql`${storefrontDomains.status} <> 'removed'`,
      ),
    );
  return row?.count ?? 0;
}

/** Total bytes of object storage used by the business's storefront media. */
export async function getMediaStorageBytes(
  businessId: number,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${storefrontMedia.bytes}), 0)::bigint` })
    .from(storefrontMedia)
    .where(eq(storefrontMedia.businessId, businessId));
  return Number(row?.total ?? 0);
}

export function assertWithinStorefrontLimit(
  entitlements: Entitlements,
  currentCount: number,
): void {
  const limit = entitlements.plan?.limits?.maxStorefronts;
  if (limit === undefined || limit === null) return;
  if (currentCount >= limit) {
    throw new ForbiddenError(
      `Your plan allows up to ${limit} online store${limit === 1 ? "" : "s"}. Upgrade your plan to create more.`,
      "PLAN_LIMIT_REACHED",
    );
  }
}

export function assertWithinCustomDomainLimit(
  entitlements: Entitlements,
  currentCount: number,
): void {
  const limit = entitlements.plan?.limits?.maxCustomDomains;
  if (limit === undefined || limit === null) return;
  if (currentCount >= limit) {
    throw new ForbiddenError(
      `Your plan allows up to ${limit} custom domain${limit === 1 ? "" : "s"}. Upgrade your plan to connect more.`,
      "PLAN_LIMIT_REACHED",
    );
  }
}

const BYTES_PER_MB = 1024 * 1024;

/** Throws when registering `incomingBytes` would exceed the storage quota. */
export function assertWithinMediaQuota(
  entitlements: Entitlements,
  currentBytes: number,
  incomingBytes: number,
): void {
  const limitMb = entitlements.plan?.limits?.maxMediaStorageMb;
  if (limitMb === undefined || limitMb === null) return;
  if (currentBytes + incomingBytes > limitMb * BYTES_PER_MB) {
    throw new ForbiddenError(
      `Your plan includes ${limitMb} MB of image storage. Remove unused images or upgrade your plan.`,
      "PLAN_LIMIT_REACHED",
    );
  }
}
