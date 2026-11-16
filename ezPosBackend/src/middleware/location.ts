import type { NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import { locations } from "../db/schema/locations.js";
import { userLocationAssignments } from "../db/schema/userLocationAssignments.js";
import { WILDCARD_PERMISSION } from "../rbac/permissions.js";
import { listAccessibleLocationIds } from "../modules/locations/locations.service.js";
import { BadRequestError, ForbiddenError } from "../utils/handleError.js";

const LOCATION_HEADER = "x-location-id";

export interface RequestLocation {
  locationId: number;
  name: string;
  isDefault: boolean;
}

/**
 * Resolves the ACTIVE LOCATION for a request. Three layers are checked, in
 * order — business access, location access, and permissions are separate
 * concerns and each must pass:
 *
 *   1. The header value (when present) is a HINT, never proof: the location
 *      must exist, belong to the verified business, and be active.
 *   2. The caller must be an owner (wildcard) OR hold a
 *      user_location_assignments row for that location.
 *   3. When the header is absent, the business's DEFAULT location is used —
 *      the single-store workflow keeps working unchanged. A business with no
 *      locations at all yields a clear 400 (locations are created manually).
 *
 * Used by requireLocationAccess() middleware and by controllers via
 * getLocationId(req).
 */
export async function resolveRequestLocation(
  req: Request,
): Promise<RequestLocation> {
  const membership = req.membership;
  if (!membership || !req.user) {
    throw new Error(
      "resolveRequestLocation() used without requireBusinessContext — programming error",
    );
  }
  const businessId = membership.businessId;
  const callerIsOwner = membership.permissions.includes(WILDCARD_PERMISSION);

  const rawHeader = req.headers[LOCATION_HEADER];
  const raw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const headerValue =
    typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;

  const requestedId = headerValue === null ? null : Number(headerValue);
  if (headerValue !== null && (!Number.isInteger(requestedId) || requestedId! <= 0)) {
    throw new BadRequestError("A valid location ID is required.");
  }

  // Header present: load that exact location.
  if (requestedId !== null) {
    const [location] = await db
      .select({
        id: locations.id,
        name: locations.name,
        isDefault: locations.isDefault,
        status: locations.status,
      })
      .from(locations)
      .where(
        and(eq(locations.id, requestedId), eq(locations.businessId, businessId)),
      );
    // Not-found vs. foreign location are indistinguishable on purpose.
    if (!location) {
      throw new BadRequestError("Location not found.");
    }
    if (location.status !== "active") {
      throw new BadRequestError(
        "This location is deactivated and cannot be used.",
      );
    }
    if (!callerIsOwner) {
      const [assignment] = await db
        .select({ id: userLocationAssignments.id })
        .from(userLocationAssignments)
        .where(
          and(
            eq(userLocationAssignments.userId, req.user.id),
            eq(userLocationAssignments.businessId, businessId),
            eq(userLocationAssignments.locationId, location.id),
          ),
        );
      if (!assignment) {
        throw new ForbiddenError(
          "You do not have access to this location.",
        );
      }
    }
    return {
      locationId: location.id,
      name: location.name,
      isDefault: location.isDefault,
    };
  }

  // Header absent: fall back to the business's default location.
  const [defaultLocation] = await db
    .select({
      id: locations.id,
      name: locations.name,
      isDefault: locations.isDefault,
      status: locations.status,
    })
    .from(locations)
    .where(
      and(
        eq(locations.businessId, businessId),
        eq(locations.isDefault, true),
      ),
    );
  if (!defaultLocation) {
    throw new BadRequestError(
      "This business has no locations yet. Create a location before recording inventory or sales.",
    );
  }
  if (defaultLocation.status !== "active") {
    throw new BadRequestError(
      "The default location is deactivated. Activate it or choose another location.",
    );
  }
  if (!callerIsOwner) {
    const [assignment] = await db
      .select({ id: userLocationAssignments.id })
      .from(userLocationAssignments)
      .where(
        and(
          eq(userLocationAssignments.userId, req.user.id),
          eq(userLocationAssignments.businessId, businessId),
          eq(userLocationAssignments.locationId, defaultLocation.id),
        ),
      );
    if (!assignment) {
      throw new ForbiddenError(
        "You are not assigned to any location. Ask your manager to assign you.",
      );
    }
  }
  return {
    locationId: defaultLocation.id,
    name: defaultLocation.name,
    isDefault: defaultLocation.isDefault,
  };
}

// Resolution failures use BadRequestError (→ 400) and access failures use
// ForbiddenError (→ 403) so both the global error handler and sendSafeError
// map them without special-casing.

/**
 * Location-aware authorization middleware. Must run AFTER
 * requireBusinessContext (needs the verified business + membership).
 * Express 5 forwards the rejected promise to the global error handler,
 * which maps BadRequestError → 400 and ForbiddenError → 403.
 */
export function requireLocationAccess() {
  return async (req: Request, res: Response, next: NextFunction) => {
    req.location = await resolveRequestLocation(req);
    next();
  };
}

/**
 * Optional variant of resolveRequestLocation: identical validation whenever
 * a location CAN be resolved (header present, or a usable default exists),
 * but returns null instead of throwing when the business has no locations
 * at all and sent no header. Used by surfaces that stay meaningful without
 * any physical counter (e.g. the owner dashboard, and any future module
 * that must work for a bare online-only business). An explicit bad header
 * is still a 400/403 — never silently ignored.
 */
export async function resolveOptionalRequestLocation(
  req: Request,
): Promise<RequestLocation | null> {
  const membership = req.membership;
  if (!membership || !req.user) {
    throw new Error(
      "resolveOptionalRequestLocation() used without requireBusinessContext — programming error",
    );
  }
  const businessId = membership.businessId;
  const callerIsOwner = membership.permissions.includes(WILDCARD_PERMISSION);

  const rawHeader = req.headers[LOCATION_HEADER];
  const raw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const headerValue =
    typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;

  // Header present: full validation — exactly the required path's rules.
  if (headerValue !== null) {
    const requestedId = Number(headerValue);
    if (!Number.isInteger(requestedId) || requestedId! <= 0) {
      throw new BadRequestError("A valid location ID is required.");
    }
    const [location] = await db
      .select({
        id: locations.id,
        name: locations.name,
        isDefault: locations.isDefault,
        status: locations.status,
      })
      .from(locations)
      .where(
        and(eq(locations.id, requestedId), eq(locations.businessId, businessId)),
      );
    // Not-found vs. foreign location are indistinguishable on purpose.
    if (!location) {
      throw new BadRequestError("Location not found.");
    }
    if (location.status !== "active") {
      throw new BadRequestError(
        "This location is deactivated and cannot be used.",
      );
    }
    if (!callerIsOwner) {
      const [assignment] = await db
        .select({ id: userLocationAssignments.id })
        .from(userLocationAssignments)
        .where(
          and(
            eq(userLocationAssignments.userId, req.user.id),
            eq(userLocationAssignments.businessId, businessId),
            eq(userLocationAssignments.locationId, location.id),
          ),
        );
      if (!assignment) {
        throw new ForbiddenError(
          "You do not have access to this location.",
        );
      }
    }
    return {
      locationId: location.id,
      name: location.name,
      isDefault: location.isDefault,
    };
  }

  // Header absent: fall back to the business's default location — or null
  // when the business has none (this is the only difference from the
  // required variant).
  const [defaultLocation] = await db
    .select({
      id: locations.id,
      name: locations.name,
      isDefault: locations.isDefault,
      status: locations.status,
    })
    .from(locations)
    .where(
      and(
        eq(locations.businessId, businessId),
        eq(locations.isDefault, true),
      ),
    );
  if (!defaultLocation) {
    return null;
  }
  if (defaultLocation.status !== "active") {
    throw new BadRequestError(
      "The default location is deactivated. Activate it or choose another location.",
    );
  }
  if (!callerIsOwner) {
    const [assignment] = await db
      .select({ id: userLocationAssignments.id })
      .from(userLocationAssignments)
      .where(
        and(
          eq(userLocationAssignments.userId, req.user.id),
          eq(userLocationAssignments.businessId, businessId),
          eq(userLocationAssignments.locationId, defaultLocation.id),
        ),
      );
    if (!assignment) {
      throw new ForbiddenError(
        "You are not assigned to any location. Ask your manager to assign you.",
      );
    }
  }
  return {
    locationId: defaultLocation.id,
    name: defaultLocation.name,
    isDefault: defaultLocation.isDefault,
  };
}

/**
 * Optional location middleware: attaches req.location when one resolves,
 * continues with req.location unset when the business has no locations.
 */
export function requireOptionalLocation() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const resolved = await resolveOptionalRequestLocation(req);
    if (resolved) {
      req.location = resolved;
    }
    next();
  };
}

/**
 * Location id when the route ran requireOptionalLocation()/requireLocationAccess();
 * null when no location could be resolved. Safe to call on optional routes —
 * unlike getLocationId() it never throws.
 */
export function getOptionalLocationId(req: Request): number | null {
  return req.location?.locationId ?? null;
}

/**
 * Server-verified location id for controllers/services on routes that ran
 * requireLocationAccess(). Throws (→ generic 500) if the middleware was
 * skipped — a programming error, never a client error.
 */
export function getLocationId(req: Request): number {
  if (!req.location) {
    throw new Error(
      "getLocationId() used on a route without requireLocationAccess()",
    );
  }
  return req.location.locationId;
}

/**
 * Optional ?locationId query parameter shared by the reports and dashboard
 * endpoints. Absent, empty, or "all" = business-wide aggregate. A specific
 * id is validated against the caller's server-side location assignments
 * (owners pass via wildcard) — unauthorized scoping is 403, never data.
 */
export async function resolveOptionalLocationParam(
  req: Request,
): Promise<number | undefined> {
  const raw = req.query.locationId;
  if (raw === undefined || raw === "" || raw === "all") return undefined;
  const locationId = Number(raw);
  if (!Number.isInteger(locationId) || locationId <= 0) {
    throw new BadRequestError("Invalid location filter.");
  }
  const membership = req.membership;
  if (!membership || !req.user) {
    throw new BadRequestError("Authentication required.");
  }
  const callerIsOwner = membership.permissions.includes(WILDCARD_PERMISSION);
  const accessible = await listAccessibleLocationIds(
    membership.businessId,
    req.user.id,
    callerIsOwner,
  );
  if (!accessible.includes(locationId)) {
    throw new ForbiddenError("You do not have access to this location.");
  }
  return locationId;
}
