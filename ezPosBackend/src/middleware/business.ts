import type { NextFunction, Request, Response } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import { businessMemberships } from "../db/schema/businessMemberships.js";
import { businesses } from "../db/schema/businesses.js";
import { roles } from "../db/schema/roles.js";
import { subscriptions } from "../db/schema/subscriptions.js";
import { userRoles } from "../db/schema/userRoles.js";
import { rolePermissions } from "../db/schema/rolePermissions.js";
import { permissions } from "../db/schema/permissions.js";
import { computeSubscriptionState } from "../utils/subscription.js";
import { WILDCARD_PERMISSION } from "../rbac/permissions.js";

const OPEN_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due"] as const;

const TENANT_HEADER = "x-business-id";

function unauthorized(res: Response) {
  return res
    .status(401)
    .json({ success: false, message: "Authentication required." });
}

/**
 * Loads the caller's ACTIVE membership in `businessId` and the business's
 * subscription state, attaching both — plus the caller's effective
 * permission set — to the request.
 *
 * The client-supplied business selector is a HINT, never proof of access:
 * every value attached here is derived from the database. Effective
 * permissions are the union of every role the user holds in this business
 * (user_roles). The Owner holds the wildcard ("*") so the account can never
 * be locked out by a bad permission edit — a documented bootstrap safety,
 * separate from business logic which always checks specific keys.
 *
 * Permissions are re-read from the database on EVERY request, so role and
 * permission changes take effect immediately for logged-in users.
 *
 * Returns null (response already sent) when the caller has no qualifying
 * membership — indistinguishable from the business not existing, so another
 * business's record existence is never revealed.
 */
async function resolveBusinessContext(
  req: Request,
  res: Response,
  businessId: number,
  requiredRoleSlug: string | null,
): Promise<boolean> {
  const [membership] = await db
    .select({
      membershipId: businessMemberships.id,
      roleId: businessMemberships.roleId,
      roleSlug: roles.slug,
      roleName: roles.name,
      businessStatus: businesses.status,
    })
    .from(businessMemberships)
    .innerJoin(roles, eq(roles.id, businessMemberships.roleId))
    .innerJoin(businesses, eq(businesses.id, businessMemberships.businessId))
    .where(
      and(
        eq(businessMemberships.userId, req.user!.id),
        eq(businessMemberships.businessId, businessId),
        eq(businessMemberships.status, "active"),
        ...(requiredRoleSlug ? [eq(roles.slug, requiredRoleSlug)] : []),
      ),
    );

  if (!membership) {
    res.status(403).json({
      success: false,
      message: "You do not have access to this business.",
    });
    return false;
  }

  // Platform-level suspension blocks ALL access to the business —
  // stricter than subscription expiry (which keeps read-only + billing).
  if (membership.businessStatus === "suspended") {
    res.status(403).json({
      success: false,
      code: "BUSINESS_SUSPENDED",
      message:
        "This business account is suspended. Contact ezPos support to restore access.",
    });
    return false;
  }

  let effectivePermissions: string[];
  if (membership.roleSlug === "owner") {
    effectivePermissions = [WILDCARD_PERMISSION];
  } else {
    const assignments = await db
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, req.user!.id),
          eq(userRoles.businessId, businessId),
        ),
      );
    const roleIds = [
      ...new Set(assignments.map((a) => a.roleId).concat(membership.roleId)),
    ];
    effectivePermissions =
      roleIds.length === 0
        ? []
        : (
            await db
              .selectDistinct({ key: permissions.key })
              .from(rolePermissions)
              .innerJoin(
                permissions,
                eq(permissions.id, rolePermissions.permissionId),
              )
              .where(inArray(rolePermissions.roleId, roleIds))
          ).map((row) => row.key);
  }

  // The LATEST subscription in any status — computeSubscriptionState maps
  // non-open statuses (expired/canceled) to read-only, so the portal and POS
  // see the TRUE state instead of a phantom "no subscription".
  const [subscription] = await db
    .select({
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    })
    .from(subscriptions)
    .where(eq(subscriptions.businessId, businessId))
    .orderBy(desc(subscriptions.id))
    .limit(1);

  req.membership = {
    membershipId: membership.membershipId,
    businessId,
    roleSlug: membership.roleSlug,
    roleName: membership.roleName,
    permissions: effectivePermissions,
  };
  req.subscriptionAccess = computeSubscriptionState(subscription ?? null);
  return true;
}

function parseBusinessId(raw: string): number | null {
  const businessId = Number(raw);
  return Number.isInteger(businessId) && businessId > 0 ? businessId : null;
}

/**
 * Returns the server-verified businessId for a request that has passed
 * requireBusinessContext/requireBusinessAccess. Throws (→ generic 500) if
 * called on a route that skipped the middleware — a programming error, not
 * a client error.
 */
export function getBusinessId(req: Request): number {
  if (!req.user || !req.membership) {
    throw new Error(
      "getBusinessId() used on a route without requireBusinessContext/requireBusinessAccess",
    );
  }
  return req.membership.businessId;
}

/**
 * Tenant context from the `X-Business-Id` header (the POS route transport).
 * The header is a selector, never proof of access: membership is always
 * verified. Any ACTIVE member qualifies; endpoint-level access is enforced
 * by the requirePermission/requireAnyPermission middleware that follows this
 * in each route chain (the membership carries the effective permissions).
 */
export function requireBusinessContext() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return unauthorized(res);

    const rawHeader = req.headers[TENANT_HEADER];
    const raw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (typeof raw !== "string" || raw.trim() === "") {
      return res.status(400).json({
        success: false,
        message: `The ${TENANT_HEADER} header is required.`,
      });
    }
    const businessId = parseBusinessId(raw.trim());
    if (businessId === null) {
      return res.status(400).json({
        success: false,
        message: "A valid business ID is required.",
      });
    }

    try {
      const ok = await resolveBusinessContext(req, res, businessId, null);
      if (ok) next();
    } catch (err) {
      console.error("Business context check failed:", err);
      return res.status(500).json({
        success: false,
        message: "Unable to verify business access right now.",
      });
    }
  };
}

/**
 * Tenant context from a route path parameter (used by the /api/businesses
 * routes themselves). Any active member qualifies — the owner-only rule
 * applies to the POS route chain, not to these account-level routes.
 */
export function requireBusinessAccess(paramName = "businessId") {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return unauthorized(res);

    const rawParam = req.params[paramName];
    const businessId = parseBusinessId(
      typeof rawParam === "string" ? rawParam : "",
    );
    if (businessId === null) {
      return res.status(400).json({
        success: false,
        message: "A valid business ID is required.",
      });
    }

    try {
      const ok = await resolveBusinessContext(req, res, businessId, null);
      if (ok) next();
    } catch (err) {
      console.error("Business access check failed:", err);
      return res.status(500).json({
        success: false,
        message: "Unable to verify business access right now.",
      });
    }
  };
}

/**
 * Blocks state-changing business operations unless the verified subscription
 * state grants full access (active trial period or active paid plan).
 * Read-only endpoints stay reachable for expired trials.
 */
export function requireFullAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const access = req.subscriptionAccess;
  if (!access) {
    return res.status(500).json({
      success: false,
      message: "Subscription state was not evaluated for this request.",
    });
  }
  if (access.accessMode === "full") {
    next();
    return;
  }
  return res.status(403).json({
    success: false,
    code: access.trial && access.status === "expired"
      ? "TRIAL_EXPIRED"
      : "SUBSCRIPTION_REQUIRED",
    message:
      access.trial && access.status === "expired"
        ? "Your free trial has ended. Choose a plan to continue making changes."
        : "An active subscription is required for this action.",
  });
}
