import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import { businesses } from "../db/schema/businesses.js";
import { getBusinessId } from "./business.js";
import { storefrontApiKeys } from "../db/schema/storefrontApiKeys.js";
import { env } from "../config/env.js";

/**
 * Storefront API authentication (Phase 9.2).
 *
 * - `ezpos_pk_…` (publishable, stored plain): catalog reads only, optional
 *   Origin/Referer domain restriction.
 * - `ezpos_sk_…` (secret, stored SHA-256 hashed): server-to-server; order
 *   scopes. Shown once at creation.
 *
 * Every request re-reads the key row, so revocation is immediate. Requests
 * are rate-limited per key with an in-memory sliding window — correct for a
 * single backend instance (same documented limitation as the rest of the
 * rate limiting); a shared store is required before scaling out.
 */

export const STOREFRONT_SCOPES = [
  "products:read",
  "inventory:read",
  "orders:read",
  "orders:write",
] as const;

export type StorefrontScope = (typeof STOREFRONT_SCOPES)[number];

const PUBLISHABLE_SCOPES: StorefrontScope[] = ["products:read", "inventory:read"];

export interface StorefrontContext {
  keyId: number;
  businessId: number;
  integrationId: number | null;
  scopes: StorefrontScope[];
  isPublishable: boolean;
  /** Business operating mode, for requireBusinessMode(). */
  mode: "physical_only" | "online_only" | "omnichannel";
}

declare module "express-serve-static-core" {
  interface Request {
    storefront?: StorefrontContext;
  }
}

export function generatePublishableKey(): string {
  return `ezpos_pk_${randomBytes(24).toString("hex")}`;
}

export function generateSecretKey(): string {
  return `ezpos_sk_${randomBytes(24).toString("hex")}`;
}

export function hashSecretKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// --- per-key rate limiting (fixed window, in-memory) ---

const buckets = new Map<number, { count: number; resetAt: number }>();

function rateLimitKey(keyId: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(keyId);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(keyId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (bucket.count >= env.storefrontRateLimitPerMinute) {
    return false;
  }
  bucket.count += 1;
  return true;
}

function domainAllowed(
  ctx: {
    allowedDomains: string[] | null;
    isPublishable: boolean;
  },
  req: Request,
): boolean {
  if (!ctx.isPublishable || !ctx.allowedDomains || ctx.allowedDomains.length === 0) {
    return true; // domain restrictions apply to publishable keys only
  }
  const origin = (req.headers.origin ?? req.headers.referer ?? "") as string;
  if (!origin) return false;
  return ctx.allowedDomains.some((domain) => origin.includes(domain));
}

export function authenticateStorefrontKey(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  void (async () => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token.startsWith("ezpos_pk_") && !token.startsWith("ezpos_sk_")) {
      return res.status(401).json({
        success: false,
        message: "A storefront API key is required (Authorization: Bearer …).",
      });
    }

    const isPublishable = token.startsWith("ezpos_pk_");
    const [key] = isPublishable
      ? await db
          .select()
          .from(storefrontApiKeys)
          .where(
            and(
              eq(storefrontApiKeys.publishableKey, token),
              isNull(storefrontApiKeys.revokedAt),
            ),
          )
          .limit(1)
      : await db
          .select()
          .from(storefrontApiKeys)
          .where(
            and(
              eq(storefrontApiKeys.secretKeyHash, hashSecretKey(token)),
              isNull(storefrontApiKeys.revokedAt),
            ),
          )
          .limit(1);

    if (!key) {
      return res.status(401).json({
        success: false,
        message: "This API key is invalid or has been revoked.",
      });
    }
    if (!rateLimitKey(key.id)) {
      return res.status(429).json({
        success: false,
        message: "API rate limit exceeded for this key. Try again shortly.",
      });
    }

    const [business] = await db
      .select({ mode: businesses.mode })
      .from(businesses)
      .where(eq(businesses.id, key.businessId));
    if (!business) {
      return res
        .status(401)
        .json({ success: false, message: "This API key is invalid." });
    }

    const scopes = isPublishable ? PUBLISHABLE_SCOPES : (key.scopes as StorefrontScope[]);
    if (!domainAllowed({ allowedDomains: key.allowedDomains, isPublishable }, req)) {
      return res.status(403).json({
        success: false,
        message: "This origin is not allowed for this API key.",
      });
    }

    void db
      .update(storefrontApiKeys)
      .set({
        requestCount: key.requestCount + 1,
        lastUsedAt: new Date(),
      })
      .where(eq(storefrontApiKeys.id, key.id));

    req.storefront = {
      keyId: key.id,
      businessId: key.businessId,
      integrationId: key.integrationId,
      scopes,
      isPublishable,
      mode: business.mode,
    };
    next();
  })().catch((err) => {
    console.error("Storefront auth failed:", err);
    res.status(500).json({ success: false, message: "Authentication failed." });
  });
}

export function requireStorefrontScope(scope: StorefrontScope) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.storefront?.scopes.includes(scope)) {
      next();
      return;
    }
    res.status(403).json({
      success: false,
      message: `This API key does not have the '${scope}' scope.`,
    });
  };
}

/** Storefront surfaces exist only for online-capable businesses. */
export function requireBusinessMode(
  ...modes: ("physical_only" | "online_only" | "omnichannel")[]
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.storefront && modes.includes(req.storefront.mode)) {
      next();
      return;
    }
    res.status(403).json({
      success: false,
      message:
        "This business is not configured for online sales. Switch the business mode first.",
    });
  };
}

/** Portal-side mode gate: reads the verified business's mode from the DB. */
export function requireBusinessModePortal(
  ...modes: ("physical_only" | "online_only" | "omnichannel")[]
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const [business] = await db
          .select({ mode: businesses.mode })
          .from(businesses)
          .where(eq(businesses.id, getBusinessId(req)));
        if (business && modes.includes(business.mode)) {
          next();
          return;
        }
        res.status(403).json({
          success: false,
          message:
            "This business is not configured for online sales. Switch the business mode first.",
        });
      } catch (err) {
        console.error("Business mode check failed:", err);
        res
          .status(500)
          .json({ success: false, message: "Unable to verify the business mode." });
      }
    })();
  };
}

/**
 * Generic surface gate for the authenticated business chain (runs after
 * requireBusinessContext/requireBusinessAccess): blocks routes belonging to
 * a surface the business has not activated in its operating model — e.g.
 * counter sales for an online-only business. The DB is re-read per request,
 * so a mode switch takes effect immediately. Message varies by direction.
 */
export function requireSurfaceModes(
  modes: ("physical_only" | "online_only" | "omnichannel")[],
  message?: string,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const [business] = await db
          .select({ mode: businesses.mode })
          .from(businesses)
          .where(eq(businesses.id, getBusinessId(req)));
        if (business && modes.includes(business.mode)) {
          next();
          return;
        }
        res.status(403).json({
          success: false,
          code: "SURFACE_NOT_ACTIVE",
          message:
            message ??
            "This feature is not active for the current operating model. Switch it in Settings → Business Operations.",
        });
      } catch (err) {
        console.error("Business surface check failed:", err);
        res
          .status(500)
          .json({ success: false, message: "Unable to verify the business mode." });
      }
    })();
  };
}
