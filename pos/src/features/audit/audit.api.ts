import api from "../../api/axios.js";

export interface AuditLogRow {
  id: number;
  action: string;
  entityType: string;
  entityId: number | null;
  actorUserId: number | null;
  actorName: string | null;
  actorRole: string | null;
  locationId: number | null;
  locationName: string | null;
  metadata: Record<string, unknown>;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  requestId: string | null;
  createdAt: string;
}

export interface AuditLogFilters {
  action?: string;
  actionPrefix?: string;
  entityType?: string;
  entityId?: number;
  actorUserId?: number;
  locationId?: number;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function getAuditLogApi(
  filters: AuditLogFilters,
): Promise<{ rows: AuditLogRow[]; total: number }> {
  const params: Record<string, string> = {};
  if (filters.action) params.action = filters.action;
  if (filters.actionPrefix) params.actionPrefix = filters.actionPrefix;
  if (filters.entityType) params.entityType = filters.entityType;
  if (filters.entityId !== undefined) params.entityId = String(filters.entityId);
  if (filters.actorUserId !== undefined)
    params.actorUserId = String(filters.actorUserId);
  if (filters.locationId !== undefined)
    params.locationId = String(filters.locationId);
  if (filters.from) params.from = filters.from;
  if (filters.to) params.to = filters.to;
  if (filters.limit !== undefined) params.limit = String(filters.limit);
  if (filters.offset !== undefined) params.offset = String(filters.offset);
  const res = await api.get<{ success: boolean; data: { rows: AuditLogRow[]; total: number } }>(
    "/audit-log",
    { params },
  );
  return res.data.data;
}

/** Downloads the guarded CSV export with the same filters. */
export async function exportAuditLogApi(filters: AuditLogFilters): Promise<void> {
  const params: Record<string, string> = {};
  if (filters.action) params.action = filters.action;
  if (filters.actionPrefix) params.actionPrefix = filters.actionPrefix;
  if (filters.entityType) params.entityType = filters.entityType;
  if (filters.entityId !== undefined) params.entityId = String(filters.entityId);
  if (filters.actorUserId !== undefined)
    params.actorUserId = String(filters.actorUserId);
  if (filters.from) params.from = filters.from;
  if (filters.to) params.to = filters.to;
  const res = await api.get("/audit-log/export", {
    params,
    responseType: "blob",
  });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
