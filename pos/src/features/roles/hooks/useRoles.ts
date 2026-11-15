import { useQuery } from "@tanstack/react-query";
import { getActiveBusinessId } from "@/api/axios.js";
import { getRolesApi } from "../roles.api.js";

/**
 * Role summaries (Phase 6 Feature 1). Shared by the Users page (role
 * filters + assignment dialogs) and the Roles page. The old pages soft-
 * failed to an empty list when the roles fetch errored — the queryFn keeps
 * that contract so a roles outage never blocks user management.
 */
export const roleKeys = {
  all: ["roles"] as const,
  list: () => ["roles", getActiveBusinessId(), "list"] as const,
};

export function useRolesListQuery() {
  return useQuery({
    queryKey: roleKeys.list(),
    queryFn: () => getRolesApi().catch(() => []),
  });
}
