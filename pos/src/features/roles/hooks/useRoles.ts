import { useQuery } from "@tanstack/react-query";
import { getActiveBusinessId } from "@/api/axios.js";
import {
  getPermissionCatalogApi,
  getRoleUsersApi,
  getRolesApi,
  type PermissionCatalogEntry,
  type RoleSummary,
} from "../roles.api.js";

/**
 * Role data (Phase 6 Feature 1, domain 4). Shared by the Users page and the
 * Roles page. The two pages historically had DIFFERENT failure semantics:
 * the Users page soft-failed to an empty list (a roles outage must not
 * block user management), while the Roles page hard-failed with a toast.
 * `softFail` preserves each page's contract on the same cache key.
 */
export const roleKeys = {
  all: ["roles"] as const,
  list: () => ["roles", getActiveBusinessId(), "list"] as const,
  users: (roleId: number) => ["roles", getActiveBusinessId(), roleId, "users"] as const,
  permissionCatalog: () => ["permissions-catalog"] as const,
};

export function useRolesListQuery(options: { softFail?: boolean } = {}) {
  const softFail = options.softFail ?? true;
  return useQuery({
    queryKey: roleKeys.list(),
    queryFn: () =>
      softFail ? getRolesApi().catch(() => [] as RoleSummary[]) : getRolesApi(),
  });
}

/** Server catalog only (R1-3): a partial client fallback would let a save
 *  strip permissions. The Roles page blocks editing while this errors. */
export function usePermissionCatalogQuery() {
  return useQuery({
    queryKey: roleKeys.permissionCatalog(),
    queryFn: getPermissionCatalogApi,
  });
}

/** Users holding a role — fetched only while the dialog is open. */
export function useRoleUsersQuery(roleId: number | null) {
  return useQuery({
    queryKey: roleKeys.users(roleId ?? 0),
    queryFn: () => getRoleUsersApi(roleId as number),
    enabled: roleId !== null,
  });
}

export type { PermissionCatalogEntry, RoleSummary };
