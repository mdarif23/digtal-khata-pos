import { useQuery } from "@tanstack/react-query";
import { getActiveBusinessId } from "@/api/axios.js";
import { getUsersApi } from "../users.api.js";

/**
 * Staff-user list data (Phase 6 Feature 1, domain 4). The page keeps its
 * dialog/form state; member create/update patch the query cache with the
 * same local-patch-no-refetch semantics the old useState array had.
 */
export const userKeys = {
  all: ["users"] as const,
  list: () => ["users", getActiveBusinessId(), "list"] as const,
};

export function useUsersQuery() {
  return useQuery({
    queryKey: userKeys.list(),
    queryFn: getUsersApi,
  });
}
