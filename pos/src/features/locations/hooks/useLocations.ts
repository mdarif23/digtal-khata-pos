import { useQuery } from "@tanstack/react-query";
import { getActiveBusinessId } from "@/api/axios.js";
import { getLocationsApi } from "../locations.api.js";

/**
 * Manageable-location summaries (Phase 6 Feature 1) — the staff-assignment
 * lists on the Users page. Soft-fails to an empty list like the old inline
 * fetch (a locations outage must not block user management).
 */
export const locationKeys = {
  all: ["locations"] as const,
  list: () => ["locations", getActiveBusinessId(), "list"] as const,
};

export function useLocationsQuery() {
  return useQuery({
    queryKey: locationKeys.list(),
    queryFn: () => getLocationsApi().catch(() => []),
  });
}
