import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import {
  notificationPrefs,
  notificationReads,
  notifications,
} from "../db/schema/notifications.js";
import { BadRequestError } from "../utils/handleError.js";
import { publishRealtime } from "../modules/realtime/realtime.service.js";
import type { DbTransaction } from "../modules/purchases/purchase.types.js";

/**
 * Notification center (Module 14): generated from real backend events with
 * per-day deduplication, delivered over the existing SSE stream. Muted
 * kinds (per user) are filtered at READ time — generation always records
 * the event so history stays complete.
 */

type Tx = DbTransaction | typeof db;

export type NotificationKind =
  | "low_stock"
  | "out_of_stock"
  | "expiring_inventory"
  | "register_discrepancy"
  | "integration_failure"
  | "price_increase"
  | "budget_alert"
  | "system"
  | "backup"
  | "restore";

export interface NotifyInput {
  businessId: number;
  kind: NotificationKind;
  severity?: "info" | "warning" | "critical";
  title: string;
  body?: string | null;
  payload?: Record<string, unknown> | null;
  /** Repeats with the same key on the same day are suppressed. */
  dedupeKey?: string | null;
}

function dedupeKeyFor(input: NotifyInput): string | null {
  if (!input.dedupeKey) return null;
  const day = new Date().toISOString().slice(0, 10);
  return `${input.dedupeKey}:${day}`;
}

/**
 * Records a notification (deduplicated) and pushes the SSE signal. Safe
 * inside a transaction — the SSE push happens after the caller's commit
 * flows (the signal is advisory; clients refetch through the API).
 */
export async function notifyInTx(
  tx: Tx,
  input: NotifyInput,
): Promise<number | null> {
  const dedupeKey = dedupeKeyFor(input);
  const [created] = await tx
    .insert(notifications)
    .values({
      businessId: input.businessId,
      kind: input.kind,
      severity: input.severity ?? "info",
      title: input.title,
      body: input.body ?? null,
      payload: input.payload ?? null,
      dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (!created) return null; // deduped
  publishRealtime(input.businessId, null, { kind: "notification.created" });
  return created.id;
}

/** Stock alerts after a sale reduces a variant's quantity. */
export async function notifyStockLevel(
  tx: Tx,
  input: {
    businessId: number;
    variantId: number;
    productName: string;
    newQuantity: number;
    alertQuantity: number;
    locationId: number;
  },
): Promise<void> {
  if (input.newQuantity <= 0) {
    await notifyInTx(tx, {
      businessId: input.businessId,
      kind: "out_of_stock",
      severity: "critical",
      title: `${input.productName} is out of stock`,
      body: "Sellouts block sales — restock or transfer stock to this location.",
      payload: { variantId: input.variantId, locationId: input.locationId },
      dedupeKey: `out_of_stock:${input.variantId}:${input.locationId}`,
    });
    return;
  }
  if (input.alertQuantity > 0 && input.newQuantity <= input.alertQuantity) {
    await notifyInTx(tx, {
      businessId: input.businessId,
      kind: "low_stock",
      severity: "warning",
      title: `${input.productName} is running low`,
      body: `${input.newQuantity} left (alert level ${input.alertQuantity}).`,
      payload: { variantId: input.variantId, locationId: input.locationId },
      dedupeKey: `low_stock:${input.variantId}:${input.locationId}`,
    });
  }
}

/** Expiring batches — swept daily by the scheduler. */
export async function notifyExpiringBatches(
  businessId: number,
  batches: { batchId: number; productName: string; expiryDate: string; quantity: number }[],
): Promise<void> {
  for (const batch of batches) {
    await notifyInTx(db, {
      businessId,
      kind: "expiring_inventory",
      severity: "warning",
      title: `${batch.productName} expires soon`,
      body: `${batch.quantity} unit(s) expire on ${batch.expiryDate}.`,
      payload: { batchId: batch.batchId },
      dedupeKey: `expiring:${batch.batchId}`,
    });
  }
}

/** Register close with a cash discrepancy. */
export async function notifyRegisterDiscrepancy(
  tx: Tx,
  input: {
    businessId: number;
    sessionId: number;
    registerName: string;
    difference: number;
  },
): Promise<void> {
  await notifyInTx(tx, {
    businessId: input.businessId,
    kind: "register_discrepancy",
    severity: "warning",
    title: `Cash discrepancy on ${input.registerName}`,
    body: `Counted vs expected differs by ৳${input.difference.toFixed(2)}.`,
    payload: { sessionId: input.sessionId },
    dedupeKey: `register:${input.sessionId}`,
  });
}

/** Integration sweep failures (jobs report them; deduped per day). */
export async function notifyIntegrationFailure(
  businessId: number,
  detail: string,
): Promise<void> {
  await notifyInTx(db, {
    businessId,
    kind: "integration_failure",
    severity: "warning",
    title: "Integration sync problem",
    body: detail,
    dedupeKey: `integration:${detail.slice(0, 60)}`,
  });
}

// --- read state + prefs ------------------------------------------------------

export async function listNotifications(
  businessId: number,
  userId: number,
  limit = 50,
) {
  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      severity: notifications.severity,
      title: notifications.title,
      body: notifications.body,
      payload: notifications.payload,
      createdAt: notifications.createdAt,
      readAt: notificationReads.readAt,
    })
    .from(notifications)
    .leftJoin(
      notificationReads,
      and(
        eq(notificationReads.notificationId, notifications.id),
        eq(notificationReads.userId, userId),
      ),
    )
    .where(
      and(
        eq(notifications.businessId, businessId),
        // Muted kinds are filtered for THIS user at read time.
        sql`${notifications.kind} NOT IN (
          SELECT kind FROM notification_prefs WHERE user_id = ${userId} AND muted
        )`,
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  return rows;
}

export async function unreadCount(
  businessId: number,
  userId: number,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .leftJoin(
      notificationReads,
      and(
        eq(notificationReads.notificationId, notifications.id),
        eq(notificationReads.userId, userId),
      ),
    )
    .where(
      and(
        eq(notifications.businessId, businessId),
        sql`${notificationReads.notificationId} IS NULL`,
        sql`${notifications.kind} NOT IN (
          SELECT kind FROM notification_prefs WHERE user_id = ${userId} AND muted
        )`,
      ),
    );
  return Number(row?.count ?? 0);
}

export async function markRead(
  businessId: number,
  userId: number,
  notificationIds: number[],
): Promise<void> {
  if (notificationIds.length === 0) return;
  await db
    .insert(notificationReads)
    .values(
      notificationIds.map((notificationId) => ({
        notificationId,
        userId,
      })),
    )
    .onConflictDoNothing();
  void businessId;
}

export async function markAllRead(
  businessId: number,
  userId: number,
): Promise<void> {
  const unread = await db
    .select({ id: notifications.id })
    .from(notifications)
    .leftJoin(
      notificationReads,
      and(
        eq(notificationReads.notificationId, notifications.id),
        eq(notificationReads.userId, userId),
      ),
    )
    .where(
      and(
        eq(notifications.businessId, businessId),
        sql`${notificationReads.notificationId} IS NULL`,
      ),
    );
  await markRead(
    businessId,
    userId,
    unread.map((row) => row.id),
  );
}

export async function getPrefs(businessId: number, userId: number) {
  const kinds: NotificationKind[] = [
    "low_stock",
    "out_of_stock",
    "expiring_inventory",
    "register_discrepancy",
    "integration_failure",
  ];
  const rows = await db
    .select()
    .from(notificationPrefs)
    .where(eq(notificationPrefs.userId, userId));
  void businessId;
  return kinds.map((kind) => ({
    kind,
    muted: rows.some((row) => row.kind === kind && row.muted),
  }));
}

export async function setPref(
  userId: number,
  kind: string,
  muted: boolean,
): Promise<void> {
  await db
    .insert(notificationPrefs)
    .values({ userId, kind, muted })
    .onConflictDoUpdate({
      target: [notificationPrefs.userId, notificationPrefs.kind],
      set: { muted },
    });
}

/** Guard for the read endpoints: ids must belong to the caller's business. */
export async function assertNotificationsInBusiness(
  businessId: number,
  notificationIds: number[],
): Promise<void> {
  if (notificationIds.length === 0) return;
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.businessId, businessId),
        inArray(notifications.id, notificationIds),
      ),
    );
  if (rows.length !== notificationIds.length) {
    // Foreign ids are rejected wholesale — never partially marked.
    throw new BadRequestError("Some notifications were not found.");
  }
}


