import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { businessMemberships } from "../../db/schema/businessMemberships.js";
import { roles } from "../../db/schema/roles.js";
import { userRoles } from "../../db/schema/userRoles.js";
import { userLocationAssignments } from "../../db/schema/userLocationAssignments.js";
import { locations } from "../../db/schema/locations.js";
import { users } from "../../db/schema/users.js";
import { refreshTokens } from "../../db/schema/refreshTokens.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../utils/handleError.js";
import { hashPassword } from "../../utils/password.js";
import { WILDCARD_PERMISSION } from "../../rbac/permissions.js";
import { ensureDefaultRoles } from "../roles/roles.service.js";
import { assertWithinUserLimit } from "../../services/entitlements.js";
import type {
  CreateStaffUserInput,
  UpdateStaffUserInput,
} from "./users.validation.js";

const OWNER_SLUG = "owner";

export interface MemberSummary {
  userId: number;
  fullName: string;
  email: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date | null;
  primaryRole: { id: number; name: string; slug: string } | null;
  roles: { id: number; name: string; slug: string }[];
  /** Location ids the member can access (owners implicitly access all). */
  locations: number[];
}

/**
 * Validates that every role belongs to this business and none is the Owner
 * role — ownership is fixed at business creation and can never be granted
 * through user management (privilege-escalation guard).
 */
async function resolveAssignableRoles(
  businessId: number,
  roleIds: number[],
): Promise<{
  assignable: { id: number; name: string; slug: string }[];
  primaryRole: { id: number; name: string; slug: string };
}> {
  const uniqueIds = [...new Set(roleIds)];
  const found = await db
    .select({ id: roles.id, name: roles.name, slug: roles.slug })
    .from(roles)
    .where(and(eq(roles.businessId, businessId), inArray(roles.id, uniqueIds)));
  if (found.length !== uniqueIds.length) {
    throw new BadRequestError("One or more selected roles do not exist.");
  }
  if (found.some((role) => role.slug === OWNER_SLUG)) {
    throw new ForbiddenError(
      "The Owner role cannot be assigned. Ownership is fixed at business creation.",
    );
  }
  // Preserve the caller's order — the first role becomes the primary role.
  const byId = new Map(found.map((role) => [role.id, role]));
  const assignable = uniqueIds.map((id) => byId.get(id)!);
  const primaryRole = assignable[0];
  if (!primaryRole) {
    throw new BadRequestError("Assign at least one role.");
  }
  return { assignable, primaryRole };
}

export async function listMembers(businessId: number): Promise<MemberSummary[]> {
  const memberships = await db
    .select({
      userId: users.id,
      fullName: users.fullName,
      email: users.email,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
      primaryRoleId: roles.id,
      primaryRoleName: roles.name,
      primaryRoleSlug: roles.slug,
    })
    .from(businessMemberships)
    .innerJoin(users, eq(users.id, businessMemberships.userId))
    .innerJoin(roles, eq(roles.id, businessMemberships.roleId))
    .where(eq(businessMemberships.businessId, businessId))
    .orderBy(asc(users.id));
  if (memberships.length === 0) return [];

  const assignments = await db
    .select({
      userId: userRoles.userId,
      roleId: roles.id,
      roleName: roles.name,
      roleSlug: roles.slug,
    })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(
      and(
        eq(userRoles.businessId, businessId),
        inArray(
          userRoles.userId,
          memberships.map((m) => m.userId),
        ),
      ),
    );

  const rolesByUser = new Map<number, MemberSummary["roles"]>();
  for (const row of assignments) {
    const list = rolesByUser.get(row.userId) ?? [];
    list.push({ id: row.roleId, name: row.roleName, slug: row.roleSlug });
    rolesByUser.set(row.userId, list);
  }

  const locationRows = await db
    .select({ userId: userLocationAssignments.userId, locationId: userLocationAssignments.locationId })
    .from(userLocationAssignments)
    .where(eq(userLocationAssignments.businessId, businessId));
  const locationsByUser = new Map<number, number[]>();
  for (const row of locationRows) {
    const list = locationsByUser.get(row.userId) ?? [];
    list.push(row.locationId);
    locationsByUser.set(row.userId, list);
  }

  return memberships.map((m) => ({
    userId: m.userId,
    fullName: m.fullName,
    email: m.email,
    isActive: m.isActive,
    lastLoginAt: m.lastLoginAt,
    createdAt: m.createdAt,
    primaryRole: {
      id: m.primaryRoleId,
      name: m.primaryRoleName,
      slug: m.primaryRoleSlug,
    },
    roles: rolesByUser.get(m.userId) ?? [],
    locations: locationsByUser.get(m.userId) ?? [],
  }));
}

/**
 * Replaces a member's location assignments. Location ids must belong to the
 * business. Separate from permissions by design: what (roles) vs where
 * (locations).
 */
export async function replaceUserLocationAssignments(
  businessId: number,
  userId: number,
  locationIds: number[],
): Promise<void> {
  const uniqueIds = [...new Set(locationIds)];
  if (uniqueIds.length > 0) {
    const found = await db
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.businessId, businessId));
    const owned = new Set(found.map((row) => row.id));
    const unknown = uniqueIds.filter((id) => !owned.has(id));
    if (unknown.length > 0) {
      throw new BadRequestError(
        "One or more locations do not belong to this business.",
      );
    }
  }
  await db.transaction(async (tx) => {
    await tx
      .delete(userLocationAssignments)
      .where(
        and(
          eq(userLocationAssignments.businessId, businessId),
          eq(userLocationAssignments.userId, userId),
        ),
      );
    if (uniqueIds.length > 0) {
      await tx.insert(userLocationAssignments).values(
        uniqueIds.map((locationId) => ({ userId, businessId, locationId })),
      );
    }
  });
}

export async function createStaffUser(
  businessId: number,
  input: CreateStaffUserInput,
): Promise<MemberSummary> {
  // Makes Manager/Cashier/Accountant available for businesses created before
  // the RBAC migration; a no-op for businesses that already have them.
  await ensureDefaultRoles(businessId);

  const { assignable, primaryRole } = await resolveAssignableRoles(
    businessId,
    input.roleIds,
  );

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email));
  if (existing) {
    throw new ConflictError("A user with this email already exists.");
  }

  const passwordHash = await hashPassword(input.password);

  let createdUserId: number | undefined;
  await db.transaction(async (tx) => {
    // Plan limit: active memberships vs the subscription plan's maxUsers,
    // checked inside the insert transaction (advisory-locked) so concurrent
    // invitations cannot exceed the cap.
    await assertWithinUserLimit(businessId, tx);
    const [user] = await tx
      .insert(users)
      .values({
        email: input.email,
        passwordHash,
        fullName: input.fullName,
      })
      .returning({ id: users.id });
    if (!user) {
      throw new Error("User insert returned no row.");
    }
    await tx.insert(businessMemberships).values({
      userId: user.id,
      businessId,
      roleId: primaryRole.id,
      status: "active",
    });
    await tx.insert(userRoles).values(
      assignable.map((role) => ({
        userId: user.id,
        businessId,
        roleId: role.id,
      })),
    );
    createdUserId = user.id;
  });

  if (createdUserId === undefined) {
    throw new Error("Staff user insert did not return the user.");
  }

  // Location grants for the new member (what vs where are separate checks).
  await replaceUserLocationAssignments(
    businessId,
    createdUserId,
    input.locationIds ?? [],
  );

  const members = await listMembers(businessId);
  const created = members.find((m) => m.email === input.email);
  if (!created) {
    throw new Error("Staff user creation did not return the new member.");
  }
  return created;
}

async function getTargetMember(
  businessId: number,
  targetUserId: number,
): Promise<{ membershipId: number; primaryRoleSlug: string }> {
  const [membership] = await db
    .select({
      membershipId: businessMemberships.id,
      primaryRoleSlug: roles.slug,
    })
    .from(businessMemberships)
    .innerJoin(roles, eq(roles.id, businessMemberships.roleId))
    .where(
      and(
        eq(businessMemberships.businessId, businessId),
        eq(businessMemberships.userId, targetUserId),
      ),
    );
  if (!membership) {
    throw new NotFoundError("User not found in this business.");
  }
  return membership;
}

/**
 * Protection rules shared by role/status/password mutations:
 * - Owner accounts can only be managed by a wildcard (owner) caller.
 * - Users cannot modify their own roles or status unless they hold the
 *   wildcard — self-service escalation is always denied.
 */
function assertTargetMayBeManaged(
  targetUserId: number,
  targetPrimaryRoleSlug: string,
  callerId: number,
  callerPermissions: string[],
): void {
  const callerIsOwner = callerPermissions.includes(WILDCARD_PERMISSION);
  if (targetPrimaryRoleSlug === OWNER_SLUG && !callerIsOwner) {
    throw new ForbiddenError(
      "Only the owner can manage owner accounts.",
    );
  }
  if (targetUserId === callerId && !callerIsOwner) {
    throw new ForbiddenError(
      "You cannot change your own roles or status.",
    );
  }
}

export async function updateMember(
  businessId: number,
  callerId: number,
  callerPermissions: string[],
  targetUserId: number,
  input: UpdateStaffUserInput,
): Promise<MemberSummary> {
  const target = await getTargetMember(businessId, targetUserId);
  assertTargetMayBeManaged(
    targetUserId,
    target.primaryRoleSlug,
    callerId,
    callerPermissions,
  );

  if (input.roleIds !== undefined) {
    const { assignable, primaryRole } = await resolveAssignableRoles(
      businessId,
      input.roleIds,
    );
    await db.transaction(async (tx) => {
      await tx
        .update(businessMemberships)
        .set({ roleId: primaryRole.id, updatedAt: new Date() })
        .where(eq(businessMemberships.id, target.membershipId));
      await tx
        .delete(userRoles)
        .where(
          and(
            eq(userRoles.businessId, businessId),
            eq(userRoles.userId, targetUserId),
          ),
        );
      await tx.insert(userRoles).values(
        assignable.map((role) => ({
          userId: targetUserId,
          businessId,
          roleId: role.id,
        })),
      );
    });
  }

  if (input.isActive !== undefined) {
    await db
      .update(users)
      .set({ isActive: input.isActive, updatedAt: new Date() })
      .where(eq(users.id, targetUserId));
  }

  if (input.locationIds !== undefined) {
    await replaceUserLocationAssignments(
      businessId,
      targetUserId,
      input.locationIds,
    );
  }

  const members = await listMembers(businessId);
  const updated = members.find((m) => m.userId === targetUserId);
  if (!updated) {
    throw new Error("Member update did not return the member.");
  }
  return updated;
}

export async function resetMemberPassword(
  businessId: number,
  callerId: number,
  callerPermissions: string[],
  targetUserId: number,
  newPassword: string,
): Promise<void> {
  const target = await getTargetMember(businessId, targetUserId);
  assertTargetMayBeManaged(
    targetUserId,
    target.primaryRoleSlug,
    callerId,
    callerPermissions,
  );
  const passwordHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, targetUserId));
  // Killing every live session is the point of an admin reset — otherwise
  // the old password keeps working until each access token expires. The
  // self-service change/reset flows already did this; parity here.
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(refreshTokens.userId, targetUserId), isNull(refreshTokens.revokedAt)),
    );
}
