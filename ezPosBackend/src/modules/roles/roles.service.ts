import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { businessMemberships } from "../../db/schema/businessMemberships.js";
import { permissions } from "../../db/schema/permissions.js";
import { rolePermissions } from "../../db/schema/rolePermissions.js";
import { roles } from "../../db/schema/roles.js";
import { userRoles } from "../../db/schema/userRoles.js";
import { users } from "../../db/schema/users.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../utils/handleError.js";
import {
  DEFAULT_ROLE_PERMISSIONS,
  STAFF_ROLE_NAMES,
  STAFF_ROLE_SLUGS,
  type DefaultRoleSlug,
} from "../../rbac/permissions.js";
import { slugifyBusinessName } from "../../utils/subscription.js";
import { recordAudit, recordAuditInTx } from "../../services/audit.js";
import { WILDCARD_PERMISSION } from "../../rbac/permissions.js";
import type { CreateRoleInput, UpdateRoleInput } from "./roles.validation.js";

type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const OWNER_SLUG = "owner";

export interface RoleSummary {
  id: number;
  name: string;
  slug: string;
  isSystem: boolean;
  permissionKeys: string[];
  userCount: number;
}

async function getPermissionIdMap(
  tx: Tx,
): Promise<Map<string, number>> {
  const rows = await tx
    .select({ id: permissions.id, key: permissions.key })
    .from(permissions);
  return new Map(rows.map((row) => [row.key, row.id]));
}

/** Inserts a role plus its permission rows inside the caller's transaction. */
export async function createRoleWithPermissionsInTx(
  tx: Tx,
  businessId: number,
  name: string,
  slug: string,
  isSystem: boolean,
  permissionKeys: string[],
): Promise<{ id: number; slug: string }> {
  const [role] = await tx
    .insert(roles)
    .values({ businessId, name, slug, isSystem })
    .returning({ id: roles.id, slug: roles.slug });
  if (!role) {
    throw new Error("Role insert returned no row.");
  }
  await assignPermissionsInTx(tx, role.id, permissionKeys);
  return role;
}

async function assignPermissionsInTx(
  tx: Tx,
  roleId: number,
  permissionKeys: string[],
): Promise<void> {
  const uniqueKeys = [...new Set(permissionKeys)];
  if (uniqueKeys.length === 0) return;
  const idMap = await getPermissionIdMap(tx);
  const rows = uniqueKeys.map((key) => {
    const permissionId = idMap.get(key);
    if (permissionId === undefined) {
      throw new BadRequestError(
        `Unknown permission "${key}". Is the permission catalog seeded?`,
      );
    }
    return { roleId, permissionId };
  });
  await tx.insert(rolePermissions).values(rows).onConflictDoNothing();
}

/**
 * Creates the four system roles (Owner + Manager/Cashier/Accountant) for a
 * business if they do not exist yet, with their default permission templates.
 * Idempotent — used at business creation and lazily for businesses that
 * predate the RBAC migration.
 */
export async function ensureDefaultRoles(businessId: number): Promise<void> {
  await ensureDefaultRolesInTx(db, businessId);
}

export async function ensureDefaultRolesInTx(
  tx: Tx,
  businessId: number,
): Promise<void> {
  const existing = await tx
    .select({ slug: roles.slug })
    .from(roles)
    .where(eq(roles.businessId, businessId));
  const existingSlugs = new Set(existing.map((row) => row.slug));

  const wanted: { name: string; slug: string; keys: string[] }[] = [
    {
      name: STAFF_ROLE_NAMES.owner,
      slug: OWNER_SLUG,
      keys: DEFAULT_ROLE_PERMISSIONS.owner,
    },
    ...STAFF_ROLE_SLUGS.map((slug: DefaultRoleSlug) => ({
      name: STAFF_ROLE_NAMES[slug],
      slug,
      keys: DEFAULT_ROLE_PERMISSIONS[slug],
    })),
  ];

  for (const wantedRole of wanted) {
    if (existingSlugs.has(wantedRole.slug)) continue;
    await createRoleWithPermissionsInTx(
      tx,
      businessId,
      wantedRole.name,
      wantedRole.slug,
      true,
      wantedRole.keys,
    );
  }
}

export async function listRoles(businessId: number): Promise<RoleSummary[]> {
  const roleRows = await db
    .select({
      id: roles.id,
      name: roles.name,
      slug: roles.slug,
      isSystem: roles.isSystem,
    })
    .from(roles)
    .where(eq(roles.businessId, businessId))
    .orderBy(asc(roles.id));
  if (roleRows.length === 0) return [];

  const roleIds = roleRows.map((row) => row.id);

  const [permissionRows, userCountRows] = await Promise.all([
    db
      .select({ roleId: rolePermissions.roleId, key: permissions.key })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(inArray(rolePermissions.roleId, roleIds)),
    db
      .select({
        roleId: userRoles.roleId,
        userCount: sql<number>`count(distinct ${userRoles.userId})::int`,
      })
      .from(userRoles)
      .where(inArray(userRoles.roleId, roleIds))
      .groupBy(userRoles.roleId),
  ]);

  const keysByRole = new Map<number, string[]>();
  for (const row of permissionRows) {
    const list = keysByRole.get(row.roleId) ?? [];
    list.push(row.key);
    keysByRole.set(row.roleId, list);
  }
  const countByRole = new Map(
    userCountRows.map((row) => [row.roleId, Number(row.userCount)]),
  );

  return roleRows.map((row) => ({
    ...row,
    permissionKeys: (keysByRole.get(row.id) ?? []).sort(),
    userCount: countByRole.get(row.id) ?? 0,
  }));
}

export interface PermissionCatalogEntry {
  key: string;
  module: string | null;
  description: string | null;
}

export async function listPermissionCatalog(): Promise<
  PermissionCatalogEntry[]
> {
  return db
    .select({
      key: permissions.key,
      module: permissions.module,
      description: permissions.description,
    })
    .from(permissions)
    .orderBy(asc(permissions.module), asc(permissions.key));
}

async function getBusinessRole(
  businessId: number,
  roleId: number,
): Promise<{
  id: number;
  name: string;
  slug: string;
  isSystem: boolean;
  permissionKeys: string[];
}> {
  const [role] = await db
    .select({
      id: roles.id,
      name: roles.name,
      slug: roles.slug,
      isSystem: roles.isSystem,
    })
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.businessId, businessId)));
  if (!role) {
    throw new NotFoundError("Role not found.");
  }
  const keys = await db
    .select({ key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(rolePermissions.roleId, roleId));
  return { ...role, permissionKeys: keys.map((k) => k.key).sort() };
}

/**
 * Self-escalation guard: a caller may not modify or delete a role they
 * currently hold — they could grant themselves new permissions. Callers with
 * the owner wildcard are exempt (the owner account is trusted to manage all
 * roles, and cannot hold the roles it needs to govern).
 */
async function assertCallerDoesNotHoldRole(
  businessId: number,
  callerId: number,
  callerPermissions: string[],
  roleId: number,
): Promise<void> {
  if (callerPermissions.includes(WILDCARD_PERMISSION)) return;
  const [held] = await db
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, callerId),
        eq(userRoles.businessId, businessId),
        eq(userRoles.roleId, roleId),
      ),
    );
  if (held) {
    throw new ForbiddenError(
      "You cannot modify a role that is assigned to you. Ask another owner or manager to make this change.",
    );
  }
}

export async function createRole(
  businessId: number,
  input: CreateRoleInput,
  callerId: number | null = null,
): Promise<RoleSummary> {
  const slug = slugifyBusinessName(input.name).slice(0, 50);
  const [existing] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.businessId, businessId), eq(roles.slug, slug)));
  if (existing) {
    throw new ConflictError("A role with this name already exists.");
  }

  return db.transaction(async (tx) => {
    const role = await createRoleWithPermissionsInTx(
      tx,
      businessId,
      input.name,
      slug,
      false,
      input.permissionKeys,
    );
    recordAudit({
      businessId,
      actorUserId: callerId,
      action: "role.created",
      entityType: "role",
      entityId: role.id,
      afterState: { name: input.name, slug },
    });
    return {
      id: role.id,
      name: input.name,
      slug,
      isSystem: false,
      permissionKeys: [...new Set(input.permissionKeys)].sort(),
      userCount: 0,
    };
  });
}

export async function updateRole(
  businessId: number,
  callerId: number,
  callerPermissions: string[],
  roleId: number,
  input: UpdateRoleInput,
): Promise<RoleSummary> {
  const role = await getBusinessRole(businessId, roleId);
  if (role.slug === OWNER_SLUG) {
    throw new ForbiddenError("The Owner role cannot be modified.");
  }
  await assertCallerDoesNotHoldRole(
    businessId,
    callerId,
    callerPermissions,
    roleId,
  );

  if (role.isSystem && input.name !== undefined && input.name !== role.name) {
    throw new BadRequestError("Default roles cannot be renamed.");
  }

  await db.transaction(async (tx) => {
    if (input.permissionKeys !== undefined) {
      await tx
        .delete(rolePermissions)
        .where(eq(rolePermissions.roleId, roleId));
      await assignPermissionsInTx(tx, roleId, input.permissionKeys);
    }
    if (input.name !== undefined && !role.isSystem) {
      await tx
        .update(roles)
        .set({ name: input.name })
        .where(eq(roles.id, roleId));
    }
    // Phase 1: permission-set changes are a core audit event (F12-A) — the
    // before/after key lists are the whole diff.
    if (input.permissionKeys !== undefined) {
      recordAuditInTx(tx, {
        businessId,
        actorUserId: callerId,
        action: "role.permissions_changed",
        entityType: "role",
        entityId: roleId,
        beforeState: { permissionKeys: role.permissionKeys },
        afterState: {
          permissionKeys: [...new Set(input.permissionKeys)].sort(),
        },
      });
    }
  });

  const [updated] = await listRoles(businessId).then((all) =>
    all.filter((r) => r.id === roleId),
  );
  if (!updated) {
    throw new Error("Role update did not return the updated role.");
  }
  return updated;
}

export async function deleteRole(
  businessId: number,
  callerId: number,
  callerPermissions: string[],
  roleId: number,
): Promise<void> {
  const role = await getBusinessRole(businessId, roleId);
  if (role.slug === OWNER_SLUG) {
    throw new ForbiddenError("The Owner role cannot be deleted.");
  }
  if (role.isSystem) {
    throw new ForbiddenError("Default roles cannot be deleted.");
  }
  await assertCallerDoesNotHoldRole(
    businessId,
    callerId,
    callerPermissions,
    roleId,
  );

  const [assignment] = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(eq(userRoles.roleId, roleId))
    .limit(1);
  if (assignment) {
    throw new ConflictError(
      "This role is still assigned to one or more users. Remove the assignment first.",
    );
  }

  // businessMemberships.roleId references roles with ON DELETE RESTRICT, so
  // a role still used as a primary role would fail at the FK — check first.
  const [primaryRoleUse] = await db
    .select({ id: businessMemberships.id })
    .from(businessMemberships)
    .where(eq(businessMemberships.roleId, roleId))
    .limit(1);
  if (primaryRoleUse) {
    throw new ConflictError(
      "This role is still the primary role of one or more users. Remove the assignment first.",
    );
  }

  await db.delete(roles).where(eq(roles.id, roleId));
  // Phase 1: administration audit.
  recordAudit({
    businessId,
    actorUserId: callerId,
    action: "role.deleted",
    entityType: "role",
    entityId: roleId,
    beforeState: { name: role.name, slug: role.slug },
  });
}

export interface RoleUser {
  userId: number;
  fullName: string;
  email: string;
  isActive: boolean;
}

export async function listRoleUsers(
  businessId: number,
  roleId: number,
): Promise<RoleUser[]> {
  await getBusinessRole(businessId, roleId);
  return db
    .select({
      userId: users.id,
      fullName: users.fullName,
      email: users.email,
      isActive: users.isActive,
    })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(
      and(eq(userRoles.roleId, roleId), eq(userRoles.businessId, businessId)),
    );
}
