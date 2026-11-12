import { db } from "../db/schema/index.js";
import { auditLog } from "../db/schema/auditLog.js";

/**
 * Audit recording for financial operations. The in-transaction variant is
 * preferred: the entry commits or rolls back together with the change it
 * describes. The standalone variant is for operations without a wrapping
 * transaction — best-effort by design so a failed audit write can never
 * break the business operation it observes.
 */

export interface AuditEntry {
  /** null = platform-level event. */
  businessId: number | null;
  /** null = performed by the system (jobs, gateway IPN callbacks). */
  actorUserId: number | null;
  /** Dot-namespaced verb, e.g. "sale.create", "sale.refund". */
  action: string;
  entityType: string;
  entityId?: number | null;
  /** Shallow, non-sensitive details — amounts, statuses, ids. Never references or secrets. */
  metadata?: Record<string, unknown>;
  /** Counter/location context when the event happened at a shop. */
  locationId?: number | null;
  /** The actor's role name at event time (denormalized — roles change). */
  actorRole?: string | null;
  /** Safe before snapshot — shallow fields only, never secrets. */
  beforeState?: Record<string, unknown> | null;
  /** Safe after snapshot — shallow fields only, never secrets. */
  afterState?: Record<string, unknown> | null;
  /** Correlation id for tracing one request across multiple audit rows. */
  requestId?: string | null;
}

/** Transaction handle type for recordAuditInTx callers (shared). */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** recordAuditInTx only inserts — it accepts the root db handle too, so
 * helpers typed with a db-or-tx union (e.g. register attribution) can call
 * it without casts. */
export type DbLike = typeof db | Tx;

export async function recordAuditInTx(tx: DbLike, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    businessId: entry.businessId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? {},
    ...(entry.locationId != null ? { locationId: entry.locationId } : {}),
    ...(entry.actorRole != null ? { actorRole: entry.actorRole } : {}),
    ...(entry.beforeState != null ? { beforeState: entry.beforeState } : {}),
    ...(entry.afterState != null ? { afterState: entry.afterState } : {}),
    ...(entry.requestId != null ? { requestId: entry.requestId } : {}),
  });
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      businessId: entry.businessId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ?? {},
      ...(entry.locationId != null ? { locationId: entry.locationId } : {}),
      ...(entry.actorRole != null ? { actorRole: entry.actorRole } : {}),
      ...(entry.beforeState != null ? { beforeState: entry.beforeState } : {}),
      ...(entry.afterState != null ? { afterState: entry.afterState } : {}),
      ...(entry.requestId != null ? { requestId: entry.requestId } : {}),
    });
  } catch {
    // Audit is observability, not a business rule — swallow. In-tx callers
    // are the reliable path; this variant covers non-transactional flows.
  }
}
