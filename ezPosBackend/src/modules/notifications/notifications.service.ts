import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { notifications } from "../../db/schema/notifications.js";

/**
 * In-app notifications (portal bell). Business-scoped: every active
 * notification row is visible to the business's portal. Emitters write
 * rows directly at the point of the event (often alongside webhooks).
 */

export interface NotificationInput {
  type: string;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: number | null;
}

export async function emitNotification(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
  businessId: number,
  input: NotificationInput,
): Promise<void> {
  await tx.insert(notifications).values({
    businessId,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
  });
}

export async function listNotifications(
  businessId: number,
): Promise<{
  notifications: {
    id: number;
    type: string;
    title: string;
    body: string | null;
    readAt: Date | null;
    createdAt: Date;
  }[];
  unreadCount: number;
}> {
  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(eq(notifications.businessId, businessId))
    .orderBy(desc(notifications.id))
    .limit(20);
  const [unread] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(eq(notifications.businessId, businessId), isNull(notifications.readAt)),
    );
  return { notifications: rows, unreadCount: unread?.n ?? 0 };
}

export async function markAllRead(businessId: number): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.businessId, businessId),
        isNull(notifications.readAt),
      ),
    );
}

export async function markRead(
  businessId: number,
  notificationId: number,
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.businessId, businessId),
        isNull(notifications.readAt),
      ),
    );
}
