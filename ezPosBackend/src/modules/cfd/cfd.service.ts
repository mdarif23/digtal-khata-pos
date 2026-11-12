import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Response } from "express";
import { db } from "../../db/schema/index.js";
import { cfdDisplays, cfdPairings } from "../../db/schema/cfd.js";
import { businesses } from "../../db/schema/businesses.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";

/**
 * Customer-facing display (Phase 3 — master prompt Feature 1). Pairing uses
 * the terminal pattern (one-time hashed code, 10-min TTL); the display token
 * authenticates ONLY the read-only stream and snapshot. Payloads are pushed
 * by the POS via an authenticated endpoint and fanned out over SSE; the
 * latest snapshot persists on the display row so a reconnect restores
 * instantly. In-memory client registry matches the existing realtime module
 * (single-instance deployment documented there too).
 */

const PAIRING_TTL_MS = 10 * 60 * 1000;

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Creates a one-time pairing code; the raw code is shown exactly once. */
export async function createPairingCode(
  businessId: number,
  userId: number,
): Promise<{ code: string; expiresAt: Date }> {
  const code = randomBytes(4).toString("hex").toUpperCase(); // 8 chars
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  await db.insert(cfdPairings).values({
    businessId,
    codeHash: sha256(code),
    expiresAt,
    createdBy: userId,
  });
  return { code, expiresAt };
}

export interface ClaimedDisplay {
  displayId: number;
  name: string;
  token: string;
  businessId: number;
}

/** Claims a pairing code → creates the display and returns its token ONCE. */
export async function claimPairing(
  code: string,
  displayName: string,
): Promise<ClaimedDisplay> {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(normalized)) {
    throw new BadRequestError("Pairing codes are 8 characters.");
  }
  const [pairing] = await db
    .select()
    .from(cfdPairings)
    .where(
      and(
        eq(cfdPairings.codeHash, sha256(normalized)),
        isNull(cfdPairings.usedAt),
        gt(cfdPairings.expiresAt, new Date()),
      ),
    )
    .for("update");
  if (!pairing) {
    throw new NotFoundError("Pairing code is invalid, used or expired.");
  }
  const [claimed] = await db
    .update(cfdPairings)
    .set({ usedAt: new Date() })
    .where(and(eq(cfdPairings.id, pairing.id), isNull(cfdPairings.usedAt)))
    .returning({ id: cfdPairings.id });
  if (!claimed) {
    throw new ConflictError("Pairing code was just used by another display.");
  }

  const token = randomBytes(24).toString("hex");
  const name = displayName.trim().slice(0, 80) || "Customer display";
  const [display] = await db
    .insert(cfdDisplays)
    .values({
      businessId: pairing.businessId,
      name,
      tokenHash: sha256(token),
      createdBy: pairing.createdBy,
    })
    .returning({ id: cfdDisplays.id });
  if (!display) throw new Error("Display insert returned no row.");
  return {
    displayId: display.id,
    name,
    token,
    businessId: pairing.businessId,
  };
}

export async function listDisplays(businessId: number) {
  return db
    .select({
      id: cfdDisplays.id,
      name: cfdDisplays.name,
      status: cfdDisplays.status,
      lastSeenAt: cfdDisplays.lastSeenAt,
      payloadUpdatedAt: cfdDisplays.payloadUpdatedAt,
      createdAt: cfdDisplays.createdAt,
    })
    .from(cfdDisplays)
    .where(eq(cfdDisplays.businessId, businessId))
    .orderBy(desc(cfdDisplays.id));
}

export async function revokeDisplay(
  businessId: number,
  displayId: number,
): Promise<void> {
  const [row] = await db
    .update(cfdDisplays)
    .set({ status: "revoked" })
    .where(
      and(
        eq(cfdDisplays.id, displayId),
        eq(cfdDisplays.businessId, businessId),
      ),
    )
    .returning({ id: cfdDisplays.id });
  if (!row) throw new NotFoundError("Display not found.");
  clients.delete(displayId);
}

// --- SSE fan-out (single-instance registry, like realtime) ----------------

const clients = new Map<number, Response>();

export function attachStream(displayId: number, res: Response): void {
  clients.set(displayId, res);
}

export function detachStream(displayId: number): void {
  clients.delete(displayId);
}

export function isDisplayConnected(displayId: number): boolean {
  return clients.has(displayId);
}

export interface CfdPayload {
  status: "idle" | "cart" | "paid";
  businessName: string;
  logoUrl: string | null;
  idleMessage: string | null;
  promoMessage: string | null;
  items: {
    name: string;
    variantName: string | null;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[];
  discountTotal: number;
  vatTotal: number;
  grandTotal: number;
  paidTotal: number;
  dueTotal: number;
}

export async function pushPayload(
  businessId: number,
  displayId: number,
  payload: CfdPayload,
): Promise<{ delivered: boolean }> {
  const [display] = await db
    .select({ id: cfdDisplays.id, status: cfdDisplays.status })
    .from(cfdDisplays)
    .where(
      and(eq(cfdDisplays.id, displayId), eq(cfdDisplays.businessId, businessId)),
    )
    .limit(1);
  if (!display) throw new NotFoundError("Display not found.");
  if (display.status !== "active") {
    throw new ConflictError("This display has been revoked.");
  }
  await db
    .update(cfdDisplays)
    .set({ lastPayload: payload, payloadUpdatedAt: new Date() })
    .where(eq(cfdDisplays.id, displayId));

  const client = clients.get(displayId);
  if (!client) return { delivered: false };
  try {
    client.write(`data: ${JSON.stringify({ type: "payload", payload })}\n\n`);
    return { delivered: true };
  } catch {
    clients.delete(displayId);
    return { delivered: false };
  }
}

/** Display-token authentication → the display row (active only). */
export async function resolveDisplayByToken(
  token: string,
): Promise<{ displayId: number; businessId: number; payload: unknown } | null> {
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  const [display] = await db
    .select()
    .from(cfdDisplays)
    .where(
      and(
        eq(cfdDisplays.tokenHash, sha256(token)),
        eq(cfdDisplays.status, "active"),
      ),
    )
    .limit(1);
  if (!display) return null;
  await db
    .update(cfdDisplays)
    .set({ lastSeenAt: new Date() })
    .where(eq(cfdDisplays.id, display.id));
  return {
    displayId: display.id,
    businessId: display.businessId,
    payload: display.lastPayload ?? null,
  };
}

/** Branding + idle copy for the display payload envelope. */
export async function businessBranding(businessId: number): Promise<{
  businessName: string;
  logoUrl: string | null;
}> {
  const [business] = await db
    .select({ name: businesses.name })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return { businessName: business?.name ?? "", logoUrl: null };
}
