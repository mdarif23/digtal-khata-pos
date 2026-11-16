import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { businesses } from "../../db/schema/businesses.js";
import { integrations } from "../../db/schema/integrations.js";
import { locations } from "../../db/schema/locations.js";
import { products } from "../../db/schema/products.js";
import { registers } from "../../db/schema/registers.js";
import { storefronts } from "../../db/schema/storefronts.js";
import { businessMemberships } from "../../db/schema/businessMemberships.js";
import { roles } from "../../db/schema/roles.js";
import { units } from "../../db/schema/units.js";
import { userRoles } from "../../db/schema/userRoles.js";
import { subscriptionPlans } from "../../db/schema/subscriptionPlans.js";
import { subscriptions } from "../../db/schema/subscriptions.js";
import { users } from "../../db/schema/users.js";
import { env } from "../../config/env.js";
import { addDays, slugifyBusinessName } from "../../utils/subscription.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../utils/handleError.js";
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
        // Operating model from signup (optional; DB default is physical_only).
        // Configuration, not a permanent classification — switchable later.
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
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

    // Seed a default measurement unit so Add Product works immediately —
    // a fresh business otherwise dead-ends on the required unit dropdown.
    await tx
      .insert(units)
      .values({ businessId: business.id, name: "Piece", abbreviation: "pc" });

    // Online-capable signup: provision the single stock source immediately,
    // so inventory, purchases and online orders work with NO physical store.
    // The location is a fulfillment source (a warehouse for online-only
    // businesses), not a retail storefront. Idempotent by construction — the
    // same guarantee is applied by changeBusinessMode when the mode flips
    // later, and never duplicates when locations already exist.
    if (input.mode === "online_only" || input.mode === "omnichannel") {
      await tx.insert(locations).values({
        businessId: business.id,
        name: "Online Store",
        isDefault: true,
        locationType: input.mode === "online_only" ? "warehouse" : "store",
      });
    }

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
  /** Document branding (receipt customization). */
  logoUrl: string | null;
  website: string | null;
  vatBin: string | null;
  tagline: string | null;
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
      logoUrl: businesses.logoUrl,
      website: businesses.website,
      vatBin: businesses.vatBin,
      tagline: businesses.tagline,
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
      ...(input.website !== undefined ? { website: input.website } : {}),
      ...(input.vatBin !== undefined ? { vatBin: input.vatBin } : {}),
      ...(input.tagline !== undefined ? { tagline: input.tagline } : {}),
      updatedAt: new Date(),
    })
    .where(eq(businesses.id, businessId));

  // WB-13: the operating model is only switchable through the dedicated,
  // transactional PATCH /mode route — the profile PUT no longer carries a
  // parallel write path.

  return getBusinessForMembership(userId, businessId);
}

/**
 * Operating-model switch through the dedicated PATCH /mode route. Membership
 * is re-verified in-service (the route also enforces settings.edit), and the
 * route deliberately omits requireFullAccess: switching the operating
 * configuration is configuration, not data, so a read-only (expired-trial)
 * tenant may still flip modes even though every other write stays blocked.
 */
export async function changeBusinessModeForMembership(
  userId: number,
  businessId: number,
  mode: BusinessDetail["mode"],
): Promise<BusinessDetail> {
  await getBusinessForMembership(userId, businessId);
  await changeBusinessMode(businessId, mode);
  return getBusinessForMembership(userId, businessId);
}

export interface BusinessOperationsSummary {
  mode: BusinessDetail["mode"];
  subscription: {
    status: string;
    accessMode: string;
    trial: boolean;
  };
  counts: {
    activeLocations: number;
    activeRegisters: number;
    connectedChannels: number;
    hostedStorefronts: number;
    activeStaff: number;
    products: number;
  };
  readiness: {
    /** An active location exists — the stock source for every channel. */
    stockSourceReady: boolean;
    /** A register exists for counter sales (physical modes). */
    registerReady: boolean;
    /** A WooCommerce/custom-storefront integration is connected. */
    onlineChannelConnected: boolean;
    /** A hosted storefront has been created. */
    hostedStorefrontCreated: boolean;
    /** At least one product exists in the catalog. */
    catalogReady: boolean;
  };
}

/**
 * Configuration snapshot for Settings → Business Operations: the current
 * operating model plus what is actually set up, so the UI can guide the
 * owner through activating a channel (e.g. "enable physical operations")
 * without creating duplicate anything. Read-only — no side effects.
 */
export async function getBusinessOperationsSummary(
  businessId: number,
): Promise<BusinessOperationsSummary> {
  const [business] = await db
    .select({ mode: businesses.mode })
    .from(businesses)
    .where(eq(businesses.id, businessId));
  if (!business) {
    throw new NotFoundError("Business not found.");
  }

  const [
    subscriptionRow,
    locationCount,
    registerCount,
    integrationCount,
    storefrontCount,
    staffCount,
    productCount,
  ] = await Promise.all([
    db
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
      ),
    db
      .select({ value: count() })
      .from(locations)
      .where(and(eq(locations.businessId, businessId), eq(locations.status, "active"))),
    db
      .select({ value: count() })
      .from(registers)
      .where(and(eq(registers.businessId, businessId), eq(registers.status, "active"))),
    db
      .select({ value: count() })
      .from(integrations)
      .where(
        and(
          eq(integrations.businessId, businessId),
          sql`${integrations.status} <> 'disconnected'`,
        ),
      ),
    db
      .select({ value: count() })
      .from(storefronts)
      .where(
        and(eq(storefronts.businessId, businessId), isNull(storefronts.archivedAt)),
      ),
    db
      .select({ value: count() })
      .from(businessMemberships)
      .where(
        and(
          eq(businessMemberships.businessId, businessId),
          eq(businessMemberships.status, "active"),
        ),
      ),
    db
      .select({ value: count() })
      .from(products)
      .where(eq(products.businessId, businessId)),
  ]);

  const subscription = computeSubscriptionState(subscriptionRow[0] ?? null);
  const counts = {
    activeLocations: Number(locationCount[0]?.value ?? 0),
    activeRegisters: Number(registerCount[0]?.value ?? 0),
    connectedChannels: Number(integrationCount[0]?.value ?? 0),
    hostedStorefronts: Number(storefrontCount[0]?.value ?? 0),
    activeStaff: Number(staffCount[0]?.value ?? 0),
    products: Number(productCount[0]?.value ?? 0),
  };

  return {
    mode: business.mode,
    subscription: {
      status: subscription.status,
      accessMode: subscription.accessMode,
      trial: subscription.trial,
    },
    counts,
    readiness: {
      stockSourceReady: counts.activeLocations > 0,
      registerReady: counts.activeRegisters > 0,
      onlineChannelConnected: counts.connectedChannels > 0,
      hostedStorefrontCreated: counts.hostedStorefronts > 0,
      catalogReady: counts.products > 0,
    },
  };
}

const LOGO_MAX_BYTES = 300 * 1024; // 300 KB decoded — plenty for a receipt logo.

/** magic-byte signatures for the allowed logo image formats. */
const LOGO_SIGNATURES: Record<string, { bytes: number[]; webp?: boolean }> = {
  "image/png": { bytes: [0x89, 0x50, 0x4e, 0x47] },
  "image/jpeg": { bytes: [0xff, 0xd8, 0xff] },
  "image/webp": { bytes: [0x52, 0x49, 0x46, 0x46], webp: true }, // RIFF....WEBP
};

/**
 * Validates a `data:image/...;base64,...` logo data URL: declared type
 * allow-list, real magic bytes (never trust the declared MIME alone), and a
 * decoded size cap so the businesses row cannot balloon.
 */
export function validateLogoDataUrl(dataUrl: string): string {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(
    dataUrl,
  );
  if (!match) {
    throw new BadRequestError(
      "Logo must be a base64 data URL for a PNG, JPEG or WebP image.",
    );
  }
  const mime = match[1] ?? "";
  const base64 = (match[2] ?? "").replace(/\s/g, "");
  if (!mime || !base64) {
    throw new BadRequestError(
      "Logo must be a base64 data URL for a PNG, JPEG or WebP image.",
    );
  }
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0) {
    throw new BadRequestError("Logo image is empty.");
  }
  if (buffer.length > LOGO_MAX_BYTES) {
    throw new BadRequestError(
      `Logo is too large — keep it under ${Math.round(LOGO_MAX_BYTES / 1024)} KB.`,
    );
  }
  const signature = LOGO_SIGNATURES[mime];
  if (!signature) {
    throw new BadRequestError(
      "Logo must be a PNG, JPEG or WebP image.",
    );
  }
  const headerMatches =
    signature.bytes.every((byte, i) => buffer[i] === byte) &&
    (!signature.webp ||
      buffer.subarray(8, 12).toString("ascii") === "WEBP");
  if (!headerMatches) {
    throw new BadRequestError(
      "Logo file content does not match its declared image type.",
    );
  }
  return `data:${mime};base64,${base64}`;
}

/**
 * Store or replace the business logo (receipt customization branding).
 * Membership is re-verified in-service the same way profile updates are.
 */
export async function setBusinessLogoForMembership(
  userId: number,
  businessId: number,
  dataUrl: string,
): Promise<BusinessDetail> {
  const logoUrl = validateLogoDataUrl(dataUrl);
  // Defense-in-depth: verify the membership before mutating.
  await getBusinessForMembership(userId, businessId);

  await db
    .update(businesses)
    .set({ logoUrl, updatedAt: new Date() })
    .where(eq(businesses.id, businessId));

  return getBusinessForMembership(userId, businessId);
}

export async function removeBusinessLogoForMembership(
  userId: number,
  businessId: number,
): Promise<BusinessDetail> {
  // Defense-in-depth: verify the membership before mutating.
  await getBusinessForMembership(userId, businessId);

  await db
    .update(businesses)
    .set({ logoUrl: null, updatedAt: new Date() })
    .where(eq(businesses.id, businessId));

  return getBusinessForMembership(userId, businessId);
}

/**
 * Owner-initiated business deletion. Soft-delete by design: sales history
 * cannot be cascade-deleted safely, so the business row and its data are
 * kept — but access is fully revoked in one transaction:
 * - business status -> "inactive" (hidden from any status-aware listing),
 * - the open subscription is canceled (with a subscription event),
 * - every membership is suspended, so the business disappears from the
 *   dashboard's membership-driven list and requireBusinessAccess rejects
 *   all further API access.
 */
export async function deleteBusinessForMembership(
  userId: number,
  businessId: number,
): Promise<void> {
  const [row] = await db
    .select({ roleSlug: roles.slug })
    .from(businessMemberships)
    .innerJoin(roles, eq(roles.id, businessMemberships.roleId))
    .where(
      and(
        eq(businessMemberships.businessId, businessId),
        eq(businessMemberships.userId, userId),
        eq(businessMemberships.status, "active"),
      ),
    );
  if (!row) {
    throw new NotFoundError("Business not found.");
  }
  if (row.roleSlug !== "owner") {
    throw new ForbiddenError(
      "Only the business owner can delete a business.",
    );
  }

  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(businesses)
      .set({ status: "inactive", updatedAt: now })
      .where(eq(businesses.id, businessId));

    const open = await tx
      .select({ id: subscriptions.id, status: subscriptions.status })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.businessId, businessId),
          inArray(subscriptions.status, [...OPEN_SUBSCRIPTION_STATUSES]),
        ),
      );
    for (const subscription of open) {
      await tx
        .update(subscriptions)
        .set({ status: "canceled", canceledAt: now })
        .where(eq(subscriptions.id, subscription.id));
      await recordEvent(tx, {
        subscriptionId: subscription.id,
        eventType: "business_deleted",
        fromStatus: subscription.status,
        toStatus: "canceled",
        actor: { type: "customer", userId },
      });
    }

    await tx
      .update(businessMemberships)
      .set({ status: "suspended" })
      .where(eq(businessMemberships.businessId, businessId));
  });
}

/**
 * Operating-model change (Phase 9). Rules:
 * - Downgrading to physical_only is blocked while integrations are
 *   connected OR a hosted storefront is live (WB-08 — a silent dark site is
 *   the online-only counterpart of the integration 409).
 * - Moving to online_only/omnichannel without any ACTIVE location
 *   auto-creates a default "Online Store" location — online inventory must
 *   live somewhere (WB-07: an archived-only location is not a stock source).
 * - Serialized: two concurrent switches must not double-provision (WB-06) —
 *   the business row is locked FOR UPDATE inside the transaction and the
 *   location check re-reads under that lock.
 */
async function changeBusinessMode(
  businessId: number,
  mode: "physical_only" | "online_only" | "omnichannel",
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ mode: businesses.mode })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .for("update");
    if (!current || current.mode === mode) return;

    if (mode === "physical_only") {
      const [connected] = await tx
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
      const [liveStorefront] = await tx
        .select({ id: storefronts.id })
        .from(storefronts)
        .where(
          and(
            eq(storefronts.businessId, businessId),
            isNull(storefronts.archivedAt),
          ),
        )
        .limit(1);
      if (liveStorefront) {
        throw new ConflictError(
          "Archive the hosted storefront before switching to physical-only.",
        );
      }
    }

    await tx
      .update(businesses)
      .set({ mode, updatedAt: new Date() })
      .where(eq(businesses.id, businessId));

    if (mode !== "physical_only") {
      const [anyLocation] = await tx
        .select({ id: locations.id })
        .from(locations)
        .where(
          and(
            eq(locations.businessId, businessId),
            eq(locations.status, "active"),
          ),
        )
        .limit(1);
      if (!anyLocation) {
        await tx.insert(locations).values({
          businessId,
          name: "Online Store",
          isDefault: true,
          // Online-only: a fulfillment source, not a retail storefront.
          locationType: mode === "online_only" ? "warehouse" : "store",
        });
      }
    }
  });
}
