import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { saleOrderEvents } from "../../db/schema/saleOrderEvents.js";
import { sales } from "../../db/schema/sales.js";
import { NotFoundError } from "../../utils/handleError.js";

/**
 * Append-only order timeline (module two §7). Every meaningful order event —
 * status transitions, confirmations, packing, shipping, delivery, COD
 * collection, cancellations, returns — lands here inside the same
 * transaction as the change itself. Rows are never updated or deleted, so
 * an order's history can never be silently overwritten.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface OrderEventInput {
  businessId: number;
  saleId: number;
  eventType: string;
  previousStatus?: string | null | undefined;
  newStatus?: string | null | undefined;
  actorType?: "user" | "system" | "integration" | undefined;
  actorUserId?: number | null | undefined;
  actorLabel?: string | null | undefined;
  note?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
}

/** MUST be awaited inside the caller's transaction — the event commits
 * atomically with the change it describes. */
export async function recordOrderEventInTx(
  tx: Tx,
  entry: OrderEventInput,
): Promise<void> {
  await tx.insert(saleOrderEvents).values({
    businessId: entry.businessId,
    saleId: entry.saleId,
    eventType: entry.eventType,
    previousStatus: entry.previousStatus ?? null,
    newStatus: entry.newStatus ?? null,
    actorType: entry.actorType ?? "user",
    actorUserId: entry.actorUserId ?? null,
    actorLabel: entry.actorLabel ?? null,
    note: entry.note ?? null,
    metadata: entry.metadata ?? {},
  });
}

export interface OrderTimelineRow {
  id: number;
  eventType: string;
  previousStatus: string | null;
  newStatus: string | null;
  actorType: string;
  actorUserId: number | null;
  actorLabel: string | null;
  note: string | null;
  metadata: unknown;
  createdAt: Date | null;
}

export async function getOrderTimeline(
  businessId: number,
  saleId: number,
): Promise<OrderTimelineRow[]> {
  // Tenant guard first: a foreign order id is indistinguishable from a
  // missing one (multi-tenancy convention).
  const [sale] = await db
    .select({ id: sales.id })
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
    .limit(1);
  if (!sale) throw new NotFoundError("Order not found.");

  return db
    .select({
      id: saleOrderEvents.id,
      eventType: saleOrderEvents.eventType,
      previousStatus: saleOrderEvents.previousStatus,
      newStatus: saleOrderEvents.newStatus,
      actorType: saleOrderEvents.actorType,
      actorUserId: saleOrderEvents.actorUserId,
      actorLabel: saleOrderEvents.actorLabel,
      note: saleOrderEvents.note,
      metadata: saleOrderEvents.metadata,
      createdAt: saleOrderEvents.createdAt,
    })
    .from(saleOrderEvents)
    .where(
      and(
        eq(saleOrderEvents.businessId, businessId),
        eq(saleOrderEvents.saleId, saleId),
      ),
    )
    .orderBy(asc(saleOrderEvents.createdAt), asc(saleOrderEvents.id));
}
