import { and, eq, inArray , sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { businesses } from "../../db/schema/businesses.js";
import { integrations } from "../../db/schema/integrations.js";
import { locations } from "../../db/schema/locations.js";
import { businessMemberships } from "../../db/schema/businessMemberships.js";
import { roles } from "../../db/schema/roles.js";
import { userRoles } from "../../db/schema/userRoles.js";
import { subscriptionPlans } from "../../db/schema/subscriptionPlans.js";
import { subscriptions } from "../../db/schema/subscriptions.js";
import { users } from "../../db/schema/users.js";
import { env } from "../../config/env.js";
import { addDays, slugifyBusinessName } from "../../utils/subscription.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/handleError.js";
import { computeSubscriptionState, type SubscriptionState } from "../../utils/subscription.js";
import { createRoleWithPermissionsInTx, ensureDefaultRolesInTx } from "../roles/roles.service.js";
import { recordEvent } from "../subscriptions/subscription.service.js";
import { DEFAULT_ROLE_PERMISSIONS } from "../../rbac/permissions.js";
import type { CreateBusinessInput, UpdateBusinessInput } from "./businesses.validation.js";

const OPEN_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due"] as const;

export interface CreatedBusinessResult {
  business: {
    id: number;
    name: string;
    slug: string;
    status: string;
  };
  ownerRoleSlug: string;
  /** null when the trial plan record has not been seeded yet. */
  subscription: {
    status: string;
    trial: boolean;
    currentPeriodEnd: Date | null;
  } | null;
  trialSkipped: boolean;
}

async function generateUniqueSlug(
  name: string,
  /** Scoped to the current transaction. */
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  const base = slugifyBusinessName(name);
  if (!(await exists(base))) return base;
  for (let counter = 2; counter < 1000; counter += 1) {
    const candidate = `${base}-${counter}`.slice(0, 100);
    if (!(await exists(candidate))) return candidate;
  }
  throw new BadRequestError(
    "Could not generate a unique URL for this business name. Try another name.",
  );
}

/**
 * Activates the 14-day free trial inside the caller's transaction.
 *
 * Blocked until the trial plan record is seeded (subscriptions.planId is NOT
 * NULL and the plan row requires explicit approval): if the plan row does
 * not exist, activation is skipped safely and reported — the app never
 * inserts plan records itself. Idempotent: an existing open subscription is
 * returned as-is, never extended or duplicated (also guarded by the partial
 * unique index `subscriptions_one_open_per_business`).
 */
async function activateTrialInTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  businessId: number,
): Promise<CreatedBusinessResult["subscription"] & { trialSkipped: boolean }> {
  const [plan] = await tx
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(
      and(
        eq(subscriptionPlans.slug, env.trialPlanSlug),
        eq(subscriptionPlans.isActive, true),
      ),
    );

  if (!plan) {
    console.warn(
      `Trial activation skipped for business ${businessId}: no active "${env.trialPlanSlug}" plan record exists. Seed the plan row to enable trials.`,
    );
    return { status: "none", trial: false, currentPeriodEnd: null, trialSkipped: true };
  }

  const [existing] = await tx
    .select({
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.businessId, businessId),
        inArray(subscriptions.status, [...OPEN_SUBSCRIPTION_STATUSES]),
      ),
    );
  if (existing) {
    const state = computeSubscriptionState(existing);
    return { ...state, trialSkipped: false };
  }

  const now = new Date();
  const [subscription] = await tx
    .insert(subscriptions)
    .values({
      businessId,
      planId: plan.id,
      status: "trialing",
      startsAt: now,
      currentPeriodStart: now,
      currentPeriodEnd: addDays(now, env.trialDays),
    })
    .returning({
      id: subscriptions.id,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    });
  if (!subscription) {
    throw new Error("Subscription insert returned no row.");
  }
  await recordEvent(tx, {
    subscriptionId: subscription.id,
    eventType: "trial_started",
    fromStatus: null,
    toStatus: "trialing",
    actor: { type: "system" },
    metadata: { planId: plan.id, trialDays: env.trialDays },
  });

  const state = computeSubscriptionState(subscription);
  return { ...state, trialSkipped: false };
}

export async function createBusinessForUser(
  userId: number,
  input: CreateBusinessInput,
): Promise<CreatedBusinessResult> {
  return db.transaction(async (tx) => {
    // Serialize all of this user's concurrent business creations on their
    // users row: the trial-eligibility check below is only safe because two
    // simultaneous createBusiness calls for the same user cannot interleave.
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");

    // Trial-farming guard: a user gets at most ONE trial across all
    // businesses they own. Any prior subscription row on an owned business —
    // trialing, expired, or paid — disqualifies (the schema has no
    // "was-a-trial" marker, so this is deliberately conservative; it cannot
    // be raced because of the users-row lock above). No schema change.
    const [existingSubscription] = await tx
      .select({ id: businesses.id })
      .from(businesses)
      .innerJoin(
        businessMemberships,
        and(
          eq(businessMemberships.businessId, businesses.id),
          eq(businessMemberships.userId, userId),
          eq(businessMemberships.status, "active"),
        ),
      )
      .innerJoin(roles, eq(roles.id, businessMemberships.roleId))
      .innerJoin(
        subscriptions,
        eq(subscriptions.businessId, businesses.id),
      )
      .where(eq(roles.slug, "owner"))
      .limit(1);
    const userAlreadyUsedTrial = existingSubscription !== undefined;

    const slug = await generateUniqueSlug(input.name, async (candidate) => {
      const [row] = await tx
        .select({ id: businesses.id })
        .from(businesses)
        .where(eq(businesses.slug, candidate));
      return row !== undefined;
    });

    const [business] = await tx
      .insert(businesses)
      .values({
        name: input.name,
        slug,
        phone: input.phone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        // Server-derived: the creator, not any client-supplied user ID.
        createdByUserId: userId,
      })
      .returning({
        id: businesses.id,
        name: businesses.name,
        slug: businesses.slug,
        status: businesses.status,
      });
    if (!business) {
      throw new Error("Business insert returned no row.");
    }

    // Owner role (wildcard permissions) + the three default staff roles,
    // each with its default permission template.
    const ownerRole = await createRoleWithPermissionsInTx(
      tx,
      business.id,
      "Owner",
      "owner",
      true,
      DEFAULT_ROLE_PERMISSIONS.owner,
    );
    await ensureDefaultRolesInTx(tx, business.id);

    await tx.insert(businessMemberships).values({
      userId,
      businessId: business.id,
      roleId: ownerRole.id,
      status: "active",
    });
    await tx.insert(userRoles).values({
      userId,
      businessId: business.id,
      roleId: ownerRole.id,
    });

    const trial = userAlreadyUsedTrial
      ? {
          status: "none" as const,
          trial: false,
          currentPeriodEnd: null,
          trialSkipped: true,
        }
      : await activateTrialInTx(tx, business.id);

    return {
      business,
      ownerRoleSlug: ownerRole.slug,
      subscription: {
        status: trial.status,
        trial: trial.trial,
        currentPeriodEnd: trial.currentPeriodEnd,
      },
      trialSkipped: trial.trialSkipped,
    };
  });
}

export interface BusinessDetail {
  id: number;
  name: string;
  slug: string;
  status: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  businessType: string | null;
  country: string | null;
  currency: string;
  timezone: string;
  mode: "physical_only" | "online_only" | "omnichannel";
  createdAt: Date | null;
  subscription: SubscriptionState;
  roleSlug: string;
}

export async function getBusinessForMembership(
  userId: number,
  businessId: number,
): Promise<BusinessDetail> {
  const [row] = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      slug: businesses.slug,
      status: businesses.status,
      phone: businesses.phone,
      email: businesses.email,
      address: businesses.address,
      businessType: businesses.businessType,
      country: businesses.country,
      currency: businesses.currency,
      timezone: businesses.timezone,
      mode: businesses.mode,
      createdAt: businesses.createdAt,
      roleSlug: roles.slug,
    })
    .from(businesses)
    .innerJoin(
      businessMemberships,
      and(
        eq(businessMemberships.businessId, businesses.id),
        eq(businessMemberships.userId, userId),
        eq(businessMemberships.status, "active"),
      ),
    )
    .innerJoin(roles, eq(roles.id, businessMemberships.roleId))
    .where(eq(businesses.id, businessId));

  if (!row) {
    throw new NotFoundError("Business not found.");
  }

  const [subscription] = await db
    .select({
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.businessId, businessId),
        inArray(subscriptions.status, [...OPEN_SUBSCRIPTION_STATUSES]),
      ),
    );

  return {
    ...row,
    subscription: computeSubscriptionState(subscription ?? null),
  };
}

export async function updateBusinessForMembership(
  userId: number,
  businessId: number,
  input: UpdateBusinessInput,
): Promise<BusinessDetail> {
  // Defense-in-depth: verify the membership before mutating, so the service
  // is safe even if a future caller skips the route middleware.
  const current = await getBusinessForMembership(userId, businessId);

  await db
    .update(businesses)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.businessType !== undefined
        ? { businessType: input.businessType }
        : {}),
      ...(input.country !== undefined ? { country: input.country } : {}),
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      updatedAt: new Date(),
    })
    .where(eq(businesses.id, businessId));

  if (input.mode !== undefined) {
    await changeBusinessMode(businessId, input.mode);
  }

  return getBusinessForMembership(userId, businessId);
}

/**
 * Operating-model change (Phase 9). Rules:
 * - Downgrading to physical_only is blocked while integrations are
 *   connected (they must be disconnected first).
 * - Moving to online_only/omnichannel without any location auto-creates a
 *   default "Online Store" location — online inventory must live somewhere.
 */
async function changeBusinessMode(
  businessId: number,
  mode: "physical_only" | "online_only" | "omnichannel",
): Promise<void> {
  const [current] = await db
    .select({ mode: businesses.mode })
    .from(businesses)
    .where(eq(businesses.id, businessId));
  if (!current || current.mode === mode) return;

  if (mode === "physical_only") {
    const [connected] = await db
      .select({ id: integrations.id })
      .from(integrations)
      .where(
        and(
          eq(integrations.businessId, businessId),
          sql`${integrations.status} <> 'disconnected'`,
        ),
      )
      .limit(1);
    if (connected) {
      throw new ConflictError(
        "Disconnect all storefront integrations before switching to physical-only.",
      );
    }
  }

  await db
    .update(businesses)
    .set({ mode, updatedAt: new Date() })
    .where(eq(businesses.id, businessId));

  if (mode !== "physical_only") {
    const [anyLocation] = await db
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.businessId, businessId))
      .limit(1);
    if (!anyLocation) {
      await db.insert(locations).values({
        businessId,
        name: "Online Store",
        isDefault: true,
      });
    }
  }
}
