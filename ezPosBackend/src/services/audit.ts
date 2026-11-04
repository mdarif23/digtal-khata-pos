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
  /** null = performed by the system (jobs, gateway callbacks). */
  actorUserId: number | null;
  /** Dot-namespaced verb, e.g. "sale.create", "sale.refund". */
  action: string;
  entityType: string;
  entityId?: number | null;
  /** Shallow, non-sensitive details — amounts, statuses, ids. Never references or secrets. */
  metadata?: Record<string, unknown>;
}

/** Transaction handle type for recordAuditInTx callers (shared). */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function recordAuditInTx(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    businessId: entry.businessId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? {},
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
    });
  } catch {
    // Audit is observability, not a business rule — swallow. In-tx callers
    // are the reliable path; this variant covers non-transactional flows.
  }
}
