import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";

/**
 * Real-time register updates (Module 11) over Server-Sent Events.
 *
 * SSE over the existing Express app: no new dependency, one-way push (all
 * Module 11 needs), and EventSource reconnects natively. EventSource cannot
 * send Authorization headers, so streams authenticate with a SHORT-LIVED
 * ONE-TIME ticket minted by an authenticated endpoint. Real-time pushes are
 * a convenience signal only — clients refresh through the normal APIs and
 * the backend re-validates everything per request (they never replace
 * server-side authorization or validation).
 *
 * Single-instance, in-memory registry — the same documented single-instance
 * stance as rate limiting; move the registry to a pub/sub store before
 * scaling out.
 */

interface RealtimeTicket {
  userId: number;
  businessId: number;
  locationId: number;
  expiresAt: number;
}

interface StreamClient {
  userId: number;
  businessId: number;
  locationId: number;
  res: Response;
  openedAt: number;
}

const tickets = new Map<string, RealtimeTicket>();
const clients = new Set<StreamClient>();

const TICKET_TTL_MS = 30_000;

/** Mints a one-time ticket bound to the caller's resolved context. */
export function mintTicket(
  userId: number,
  businessId: number,
  locationId: number,
): string {
  const ticket = randomBytes(24).toString("hex");
  tickets.set(ticket, {
    userId,
    businessId,
    locationId,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  // Opportunistic cleanup of expired tickets.
  const now = Date.now();
  for (const [key, value] of tickets) {
    if (value.expiresAt < now) tickets.delete(key);
  }
  return ticket;
}

/** Consumes a ticket; returns null when unknown, expired, or already used. */
function consumeTicket(ticket: string): RealtimeTicket | null {
  const found = tickets.get(ticket);
  tickets.delete(ticket); // one-time use, even if expired
  if (!found || found.expiresAt < Date.now()) return null;
  return found;
}

/**
 * The SSE stream. The response stays open; heartbeats keep intermediaries
 * from closing idle connections. Client removal on 'close' is the single
 * source of truth for the registry.
 */
export function openStream(req: Request, res: Response): void {
  const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
  const resolved = consumeTicket(ticket);
  if (!resolved) {
    res.status(401).json({
      success: false,
      message: "Invalid or expired realtime ticket.",
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const client: StreamClient = {
    userId: resolved.userId,
    businessId: resolved.businessId,
    locationId: resolved.locationId,
    res,
    openedAt: Date.now(),
  };
  clients.add(client);

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 25_000);

  res.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

export type RealtimeEvent =
  | { kind: "sale.created"; locationId: number; saleId: number }
  | { kind: "held_sales.changed"; locationId: number }
  | { kind: "register.changed"; locationId: number };

/**
 * Publishes an event to every stream of the same business. locationId-scoped
 * events only reach that location's registers (stock and holds are
 * location-scoped); pass locationId = null for business-wide events.
 */
export function publishRealtime(
  businessId: number,
  locationId: number | null,
  event: RealtimeEvent,
): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    if (client.businessId !== businessId) continue;
    if (locationId !== null && client.locationId !== locationId) continue;
    try {
      client.res.write(payload);
    } catch {
      // Broken pipe — the close handler removes the client.
    }
  }
}

export function realtimeClientCount(): number {
  return clients.size;
}
