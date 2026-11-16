import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import { receiptShareTokens } from "../db/schema/receiptShare.js";
import { getSaleReceipt } from "../modules/sales/sales.service.js";
import { BadRequestError, NotFoundError } from "../utils/handleError.js";

/**
 * P3 Phase 4 (N1-10): receipt share links (D12). A merchant creates an
 * expiring link for a completed sale's receipt; the customer opens the URL
 * WITHOUT any account. Tokens are SHA-256 hashed (plaintext shown/copied
 * exactly once), expire, and are revocable — nothing is permanently public.
 * The public fetch returns the SAME receipt payload the POS renders, so the
 * public page reuses renderReceiptHtml — never a second receipt engine.
 */

const TTL_CHOICES = [24, 72, 168] as const;
export const DEFAULT_TTL_HOURS: (typeof TTL_CHOICES)[number] = 72;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createReceiptShareLink(
  businessId: number,
  saleId: number,
  actorUserId: number | null,
  ttlHours: number | null,
): Promise<{ token: string; expiresAt: string; url: string }> {
  const ttl = ttlHours ?? DEFAULT_TTL_HOURS;
  if (!TTL_CHOICES.includes(ttl as (typeof TTL_CHOICES)[number])) {
    throw new BadRequestError("Link lifetime must be 24, 72 or 168 hours.");
  }
  // Ownership: a foreign sale id is indistinguishable from a missing one.
  await getSaleReceipt(businessId, saleId);
  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + ttl * 3600 * 1000);
  await db.insert(receiptShareTokens).values({
    businessId,
    saleId,
    tokenHash: hashToken(token),
    expiresAt,
    createdByUserId: actorUserId,
  });
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    url: `/receipt/t/${token}`,
  };
}

export async function revokeReceiptShareLink(
  businessId: number,
  saleId: number,
  tokenId: number | null,
): Promise<{ revoked: number }> {
  const rows = await db
    .update(receiptShareTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(receiptShareTokens.businessId, businessId),
        eq(receiptShareTokens.saleId, saleId),
        isNull(receiptShareTokens.revokedAt),
        ...(tokenId !== null ? [eq(receiptShareTokens.id, tokenId)] : []),
      ),
    )
    .returning({ id: receiptShareTokens.id });
  return { revoked: rows.length };
}

export async function listReceiptShareLinks(
  businessId: number,
  saleId: number,
): Promise<
  { id: number; expiresAt: string; revokedAt: string | null; createdAt: string }[]
> {
  const rows = await db
    .select({
      id: receiptShareTokens.id,
      expiresAt: receiptShareTokens.expiresAt,
      revokedAt: receiptShareTokens.revokedAt,
      createdAt: receiptShareTokens.createdAt,
    })
    .from(receiptShareTokens)
    .where(
      and(
        eq(receiptShareTokens.businessId, businessId),
        eq(receiptShareTokens.saleId, saleId),
      ),
    )
    .orderBy(desc(receiptShareTokens.id));
  return rows.map((r) => ({
    id: r.id,
    expiresAt: r.expiresAt.toISOString(),
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Public, unauthenticated fetch: resolves the hashed token to a live,
 * unrevoked, unexpired link and returns the same receipt payload the POS
 * renders (business branding rides along). A stale token is a 404 —
 * indistinguishable from never having existed.
 */
export async function getPublicReceiptByToken(token: string) {
  if (!/^[0-9a-f]{48}$/.test(token)) {
    throw new NotFoundError("Receipt link not found.");
  }
  const [link] = await db
    .select({
      id: receiptShareTokens.id,
      businessId: receiptShareTokens.businessId,
      saleId: receiptShareTokens.saleId,
      expiresAt: receiptShareTokens.expiresAt,
      revokedAt: receiptShareTokens.revokedAt,
    })
    .from(receiptShareTokens)
    .where(eq(receiptShareTokens.tokenHash, hashToken(token)))
    .limit(1);
  if (!link) throw new NotFoundError("Receipt link not found.");
  if (link.revokedAt !== null || link.expiresAt.getTime() < Date.now()) {
    throw new NotFoundError("This receipt link has expired or was revoked.");
  }
  const receipt = await getSaleReceipt(link.businessId, link.saleId);
  return receipt;
}
