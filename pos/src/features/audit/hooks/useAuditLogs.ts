import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getActiveBusinessId } from "@/api/axios.js";
import { getAuditLogApi, type AuditLogFilters } from "../audit.api.js";

/**
 * Audit-log list (Phase 6 Feature 1, domain 4) — filterable, offset-
 * paginated, append-only trail. keepPreviousData keeps the previous page's
 * rows visible while the next page fetch is in flight (the old page did the
 * same: rows only changed after the fetch resolved).
 */
export const auditLogKeys = {
  all: ["audit-logs"] as const,
  list: (filters: AuditLogFilters) =>
    ["audit-logs", getActiveBusinessId(), "list", filters] as const,
};

export function useAuditLogsQuery(filters: AuditLogFilters) {
  return useQuery({
    queryKey: auditLogKeys.list(filters),
    queryFn: () => getAuditLogApi(filters),
    placeholderData: keepPreviousData,
  });
}
