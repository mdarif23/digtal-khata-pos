import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { auditLog } from "../../db/schema/auditLog.js";
import { locations } from "../../db/schema/locations.js";
import { users } from "../../db/schema/users.js";

/**
 * Read API over the append-only audit trail (Phase 1 — master prompt F12-E).
 * Every query is business-scoped; the routes gate on audit.view / audit.export.
 */

export interface AuditLogFilters {
  /** Exact action match, e.g. "sale.create". */
  action?: string | undefined;
  /** Action prefix match, e.g. "cash" matches cash.movement, cash.* etc. */
  actionPrefix?: string | undefined;
  entityType?: string | undefined;
  entityId?: number | undefined;
  actorUserId?: number | undefined;
  locationId?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

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
  createdAt: Date;
}

const MAX_PAGE_SIZE = 100;
const MAX_EXPORT_ROWS = 10_000;

function buildWhere(businessId: number, filters: AuditLogFilters): SQL {
  const conditions: SQL[] = [eq(auditLog.businessId, businessId)];
  if (filters.action) {
    conditions.push(eq(auditLog.action, filters.action));
  }
  if (filters.actionPrefix) {
    // Escape LIKE wildcards in the prefix — the filter is literal.
    const literal = filters.actionPrefix.replace(/[%_]/g, "\\$&");
    conditions.push(sql`${auditLog.action} LIKE ${`${literal}%`}`);
  }
  if (filters.entityType) {
    conditions.push(eq(auditLog.entityType, filters.entityType));
  }
  if (filters.entityId !== undefined) {
    conditions.push(eq(auditLog.entityId, filters.entityId));
  }
  if (filters.actorUserId !== undefined) {
    conditions.push(eq(auditLog.actorUserId, filters.actorUserId));
  }
  if (filters.locationId !== undefined) {
    conditions.push(eq(auditLog.locationId, filters.locationId));
  }
  if (filters.from) {
    conditions.push(
      gte(auditLog.createdAt, sql`${`${filters.from} 00:00:00`}::timestamp`),
    );
  }
  if (filters.to) {
    conditions.push(
      lte(auditLog.createdAt, sql`${`${filters.to} 23:59:59.999`}::timestamp`),
    );
  }
  return and(...conditions) as SQL;
}

const rowSelect = {
  id: auditLog.id,
  action: auditLog.action,
  entityType: auditLog.entityType,
  entityId: auditLog.entityId,
  actorUserId: auditLog.actorUserId,
  actorName: users.fullName,
  actorRole: auditLog.actorRole,
  locationId: auditLog.locationId,
  locationName: locations.name,
  metadata: auditLog.metadata,
  beforeState: auditLog.beforeState,
  afterState: auditLog.afterState,
  requestId: auditLog.requestId,
  createdAt: auditLog.createdAt,
};

export async function listAuditLog(
  businessId: number,
  filters: AuditLogFilters,
): Promise<{ rows: AuditLogRow[]; total: number }> {
  const where = buildWhere(businessId, filters);
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), MAX_PAGE_SIZE);
  const offset = Math.max(filters.offset ?? 0, 0);

  const rows = await db
    .select(rowSelect)
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .leftJoin(locations, eq(locations.id, auditLog.locationId))
    .where(where)
    .orderBy(desc(auditLog.id))
    .limit(limit)
    .offset(offset);

  const [counted] = await db
    .select({ total: sql<string>`COUNT(*)` })
    .from(auditLog)
    .where(where);

  return {
    rows: rows.map((r) => ({
      ...r,
      metadata: r.metadata ?? {},
      beforeState: r.beforeState ?? null,
      afterState: r.afterState ?? null,
    })),
    total: Number(counted?.total ?? 0),
  };
}

/** Flat rows for CSV export (capped). */
export async function exportAuditLog(
  businessId: number,
  filters: AuditLogFilters,
): Promise<AuditLogRow[]> {
  const where = buildWhere(businessId, filters);
  const rows = await db
    .select(rowSelect)
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .leftJoin(locations, eq(locations.id, auditLog.locationId))
    .where(where)
    .orderBy(desc(auditLog.id))
    .limit(MAX_EXPORT_ROWS);
  return rows.map((r) => ({
    ...r,
    metadata: r.metadata ?? {},
    beforeState: r.beforeState ?? null,
    afterState: r.afterState ?? null,
  }));
}
