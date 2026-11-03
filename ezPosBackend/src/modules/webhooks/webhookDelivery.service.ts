import { createHmac, randomUUID } from "node:crypto";
import { and, desc, eq, lte } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  webhookDeliveries,
  webhookEndpoints,
} from "../../db/schema/webhooks.js";
import { decryptSecret, encryptSecret } from "../../utils/encryption.js";
import { notifyIntegrationFailure } from "../../services/notifications.js";
import { NotFoundError } from "../../utils/handleError.js";

/**
 * Outbound webhook delivery (Phase 9.4). Events are queued per matching
 * endpoint and delivered asynchronously by the scheduler: HMAC-SHA256
 * signed (`X-Ezpos-Signature: sha256=<hex>` over the raw body), exponential
 * backoff, dead-letter after max attempts. Secrets are AES-encrypted at
 * rest — ezPos needs them to sign, so they are decryptable (unlike API
 * keys, which are hash-only).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const WEBHOOK_EVENTS = [
  "order.created",
  "order.paid",
  "order.cancelled",
  "order.shipped",
  "order.delivered",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookPayload {
  event: WebhookEvent;
  businessId: number;
  data: Record<string, unknown>;
  timestamp: string;
}



/**
 * Transactional variant: the delivery rows commit atomically with the
 * business change that produced the event — no race between the order
 * committing and the delivery becoming visible to the sweep.
 */
export async function emitWebhookEventInTx(
  tx: Tx,
  businessId: number,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  const endpoints = await tx
    .select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.businessId, businessId),
        eq(webhookEndpoints.status, "active"),
      ),
    );
  // Respect the endpoint's event subscription ("*" = everything).
  const matching = endpoints.filter(
    (endpoint) =>
      endpoint.events.includes("*") || endpoint.events.includes(event),
  );
  if (matching.length === 0) return;
  await tx.insert(webhookDeliveries).values(
    matching.map((endpoint) => ({
      businessId,
      endpointId: endpoint.id,
      event,
      payload: data,
    })),
  );
}

export async function emitWebhookEvent(
  businessId: number,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  const endpoints = await db
    .select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.businessId, businessId),
        eq(webhookEndpoints.status, "active"),
      ),
    );
  // Endpoint events array contains this event (or "*" for all).
  const matching = endpoints.filter(
    (endpoint) =>
      endpoint.events.includes("*") || endpoint.events.includes(event),
  );
  if (matching.length === 0) return;
  const payload: WebhookPayload = {
    event,
    businessId,
    data,
    timestamp: new Date().toISOString(),
  };
  // The delivery row stores only the data section — the envelope (event,
  // timestamp) is added at delivery time.
  await db.insert(webhookDeliveries).values(
    matching.map((endpoint) => ({
      businessId,
      endpointId: endpoint.id,
      event,
      payload: data,
    })),
  );
}

// ---------------------------------------------------------------------------
// Portal management
// ---------------------------------------------------------------------------

export interface CreatedEndpoint {
  id: number;
  url: string;
  events: string[];
  /** Shown exactly once — ezPos keeps only the encrypted secret. */
  secret: string;
}

export async function createEndpoint(
  businessId: number,
  input: { url: string; events: WebhookEvent[] },
): Promise<CreatedEndpoint> {
  const secret = `ezpos_whsec_${randomUUID().replace(/-/g, "")}`;
  const [created] = await db
    .insert(webhookEndpoints)
    .values({
      businessId,
      url: input.url,
      events: input.events,
      secretEncrypted: encryptSecret(secret),
    })
    .returning({ id: webhookEndpoints.id });
  if (!created) throw new Error("Endpoint insert returned no row.");
  return {
    id: created.id,
    url: input.url,
    events: input.events,
    secret,
  };
}

export async function listEndpoints(businessId: number) {
  return db
    .select({
      id: webhookEndpoints.id,
      url: webhookEndpoints.url,
      events: webhookEndpoints.events,
      status: webhookEndpoints.status,
      createdAt: webhookEndpoints.createdAt,
    })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.businessId, businessId))
    .orderBy(desc(webhookEndpoints.id));
}

export async function deleteEndpoint(
  businessId: number,
  endpointId: number,
): Promise<void> {
  const deleted = await db
    .delete(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.businessId, businessId),
      ),
    )
    .returning({ id: webhookEndpoints.id });
  if (deleted.length === 0) {
    throw new NotFoundError("Webhook endpoint not found.");
  }
}

export async function listDeliveries(businessId: number, endpointId: number) {
  const [endpoint] = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.businessId, businessId),
      ),
    );
  if (!endpoint) throw new NotFoundError("Webhook endpoint not found.");
  return db
    .select({
      id: webhookDeliveries.id,
      event: webhookDeliveries.event,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      responseStatus: webhookDeliveries.responseStatus,
      lastError: webhookDeliveries.lastError,
      createdAt: webhookDeliveries.createdAt,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.endpointId, endpointId))
    .orderBy(desc(webhookDeliveries.id))
    .limit(50);
}

/** Enqueues a test ping so the customer can verify delivery end to end. */
export async function sendTestEvent(
  businessId: number,
  endpointId: number,
): Promise<void> {
  const [endpoint] = await db
    .select({ id: webhookEndpoints.id, url: webhookEndpoints.url })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.businessId, businessId),
      ),
    );
  if (!endpoint) throw new NotFoundError("Webhook endpoint not found.");
  // Target the SPECIFIC endpoint — a test ping must not fan out to every
  // endpoint of the business.
  await db.insert(webhookDeliveries).values({
    businessId,
    endpointId: endpoint.id,
    event: "order.created",
    payload: {
      test: true,
      message: "This is a test event from ezPos.",
    },
  });
}

// ---------------------------------------------------------------------------
// Delivery sweep
// ---------------------------------------------------------------------------

export async function processWebhookDeliveries(
  now: Date = new Date(),
): Promise<{ delivered: number; failed: number }> {
  const due = await db
    .select({
      id: webhookDeliveries.id,
      businessId: webhookDeliveries.businessId,
      endpointId: webhookDeliveries.endpointId,
      event: webhookDeliveries.event,
      payload: webhookDeliveries.payload,
      attempts: webhookDeliveries.attempts,
      maxAttempts: webhookDeliveries.maxAttempts,
    })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        lte(webhookDeliveries.nextAttemptAt, now),
      ),
    )
    .for("update", { skipLocked: true })
    .limit(20);

  let delivered = 0;
  let failed = 0;

  for (const delivery of due) {
    const [endpoint] = await db
      .select({
        url: webhookEndpoints.url,
        secretEncrypted: webhookEndpoints.secretEncrypted,
        status: webhookEndpoints.status,
      })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, delivery.endpointId));
    if (!endpoint || endpoint.status !== "active") {
      await db
        .update(webhookDeliveries)
        .set({ status: "failed", lastError: "Endpoint removed or inactive." })
        .where(eq(webhookDeliveries.id, delivery.id));
      failed += 1;
      continue;
    }

    const secret = decryptSecret(endpoint.secretEncrypted);
    const body = JSON.stringify({
      event: delivery.event,
      data: delivery.payload,
      timestamp: now.toISOString(),
    });
    const signature = createHmac("sha256", secret)
      .update(body)
      .digest("hex");

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ezpos-Event": delivery.event,
          "X-Ezpos-Signature": `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (response.ok) {
        await db
          .update(webhookDeliveries)
          .set({
            status: "delivered",
            attempts: delivery.attempts + 1,
            responseStatus: response.status,
          })
          .where(eq(webhookDeliveries.id, delivery.id));
        delivered += 1;
      } else {
        throw new Error(`Endpoint responded ${response.status}`);
      }
    } catch (err) {
      const attempts = delivery.attempts + 1;
      const dead = attempts >= delivery.maxAttempts;
      const backoffSeconds = Math.min(3600, 2 ** attempts * 15);
      const cause = (err as Error & { cause?: Error }).cause;
      const message =
        (err as Error).message +
        (cause ? `: ${cause.message}` : "");
      await db
        .update(webhookDeliveries)
        .set({
          status: dead ? "failed" : "pending",
          attempts,
          responseStatus: null,
          lastError: message.slice(0, 1000),
          nextAttemptAt: new Date(now.getTime() + backoffSeconds * 1000),
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      if (dead) {
        // Dead-letter → tell the business (Module 14, deduped per day).
        await notifyIntegrationFailure(
          delivery.businessId,
          `Webhook delivery to endpoint #${delivery.endpointId} failed permanently: ${message.slice(0, 120)}`,
        );
      }
      failed += 1;
    }
  }
  return { delivered, failed };
}
