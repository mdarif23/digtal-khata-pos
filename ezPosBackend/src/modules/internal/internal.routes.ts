import express from "express";
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { businesses } from "../../db/schema/businesses.js";
import { storefronts } from "../../db/schema/storefronts.js";
import { storefrontDomains } from "../../db/schema/storefrontDomains.js";
import { storefrontPublishVersions } from "../../db/schema/storefrontPublishVersions.js";
import { env } from "../../config/env.js";
import { verifyPreviewToken } from "../storefronts/previewToken.js";
import * as sfInternal from "./storefront.controller.js";

/**
 * Internal endpoints for the ezPosStorefront renderer and the Caddy edge.
 *
 * Authenticated by a shared secret header (x-internal-token) — never by user
 * sessions or API keys. These routes are the ONLY place the renderer can read
 * tenant configuration, and the ONLY thing that decides which domains get
 * certificates. Host-header attacks die here: resolution is a strict lookup,
 * and anything unmatched renders the caller's parked page.
 */
const router = express.Router();

function requestToken(req: Request): string {
  const raw = req.headers["x-internal-token"];
  return (Array.isArray(raw) ? raw[0] : raw) ?? "";
}

export function requireInternalToken(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const provided = Buffer.from(requestToken(req));
  const expected = Buffer.from(env.internalApiToken);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid internal token." });
  }
  next();
}

interface ResolvedStorefront {
  storefrontId: number;
  businessId: number;
  name: string;
  subdomain: string;
  status: string;
  themeId: string;
  seo: unknown;
  contact: unknown;
  flags: {
    storePickupEnabled: boolean;
    analyticsEnabled: boolean;
    searchIndexingEnabled: boolean;
  };
  publishedVersion: number | null;
  config: Record<string, unknown> | null;
  source: "published" | "preview";
  primaryDomain: string | null;
}

async function resolveByHost(rawHost: string): Promise<{
  storefront: typeof storefronts.$inferSelect | null;
  primaryDomain: string | null;
}> {
  const host = rawHost.trim().toLowerCase().split(":")[0] ?? "";
  if (!host) return { storefront: null, primaryDomain: null };

  const baseDomain = env.storefrontBaseDomain;
  const subdomain = host.endsWith(`.${baseDomain}`)
    ? host.slice(0, -(baseDomain.length + 1))
    : host;
  const isBaseSubdomain =
    host.endsWith(`.${baseDomain}`) && !subdomain.includes(".");

  // Platform-level suspension must stop serving immediately: resolve joins
  // businesses and excludes suspended ones for BOTH host kinds.
  if (isBaseSubdomain) {
    const [row] = await db
      .select({ storefront: storefronts })
      .from(storefronts)
      .innerJoin(businesses, eq(businesses.id, storefronts.businessId))
      .where(
        and(
          eq(storefronts.subdomain, subdomain),
          sql`${businesses.status} <> 'suspended'`,
        ),
      )
      .limit(1);
    if (!row) return { storefront: null, primaryDomain: null };
    const [primary] = await db
      .select({ domain: storefrontDomains.domain })
      .from(storefrontDomains)
      .where(
        and(
          eq(storefrontDomains.storefrontId, row.storefront.id),
          eq(storefrontDomains.isPrimary, true),
        ),
      )
      .limit(1);
    return { storefront: row.storefront, primaryDomain: primary?.domain ?? null };
  }

  // Custom domain: strict single-row lookup (domains are globally unique).
  const [domainRow] = await db
    .select({ storefrontId: storefrontDomains.storefrontId })
    .from(storefrontDomains)
    .where(
      and(eq(storefrontDomains.domain, host), eq(storefrontDomains.status, "verified")),
    )
    .limit(1);
  if (!domainRow) return { storefront: null, primaryDomain: null };

  const [row] = await db
    .select({ storefront: storefronts })
    .from(storefronts)
    .innerJoin(businesses, eq(businesses.id, storefronts.businessId))
    .where(
      and(
        eq(storefronts.id, domainRow.storefrontId),
        sql`${businesses.status} <> 'suspended'`,
      ),
    )
    .limit(1);
  const [primary] = await db
    .select({ domain: storefrontDomains.domain })
    .from(storefrontDomains)
    .where(
      and(
        eq(storefrontDomains.storefrontId, domainRow.storefrontId),
        eq(storefrontDomains.isPrimary, true),
      ),
    )
    .limit(1);
  return { storefront: row?.storefront ?? null, primaryDomain: primary?.domain ?? null };
}

async function loadPublishedPayload(
  storefront: typeof storefronts.$inferSelect,
  primaryDomain: string | null,
): Promise<ResolvedStorefront> {
  let config: Record<string, unknown> | null = null;
  let publishedVersion: number | null = null;
  if (storefront.publishedVersionId) {
    const [version] = await db
      .select()
      .from(storefrontPublishVersions)
      .where(eq(storefrontPublishVersions.id, storefront.publishedVersionId))
      .limit(1);
    if (version) {
      config = version.config;
      publishedVersion = version.versionNumber;
    }
  }
  return {
    storefrontId: storefront.id,
    businessId: storefront.businessId,
    name: storefront.name,
    subdomain: storefront.subdomain,
    status: storefront.status,
    themeId: storefront.themeId,
    seo: storefront.seo ?? null,
    contact: storefront.contact ?? null,
    flags: {
      storePickupEnabled: storefront.storePickupEnabled,
      analyticsEnabled: storefront.analyticsEnabled,
      searchIndexingEnabled: storefront.searchIndexingEnabled,
    },
    publishedVersion,
    config,
    source: "published",
    primaryDomain,
  };
}

router.get("/api/internal/storefront/resolve", requireInternalToken, async (req, res) => {
  try {
    const host = String(req.query.host ?? "");
    if (!host) {
      return res
        .status(400)
        .json({ success: false, message: "The host query parameter is required." });
    }

    const { storefront, primaryDomain } = await resolveByHost(host);

    // Preview mode: a valid preview token for THIS storefront may read the
    // draft config regardless of publish status.
    const previewToken = String(req.query.preview ?? "");
    if (previewToken && storefront) {
      const claims = await verifyPreviewToken(previewToken);
      if (claims && claims.storefrontId === storefront.id) {
        return res.status(200).json({
          success: true,
          data: {
            resolved: true,
            storefront: {
              storefrontId: storefront.id,
              businessId: storefront.businessId,
              name: storefront.name,
              subdomain: storefront.subdomain,
              status: storefront.status,
              themeId: storefront.themeId,
              seo: storefront.seo ?? null,
              contact: storefront.contact ?? null,
              flags: {
                storePickupEnabled: storefront.storePickupEnabled,
                analyticsEnabled: storefront.analyticsEnabled,
                searchIndexingEnabled: storefront.searchIndexingEnabled,
              },
              publishedVersion: null,
              config: storefront.draftConfig,
              source: "preview",
              primaryDomain,
            },
          },
        });
      }
    }

    if (!storefront || storefront.status !== "published") {
      return res.status(200).json({ success: true, data: { resolved: false } });
    }

    return res.status(200).json({
      success: true,
      data: {
        resolved: true,
        storefront: await loadPublishedPayload(storefront, primaryDomain),
      },
    });
  } catch (err) {
    console.error("Internal storefront resolve failed:", err);
    return res
      .status(500)
      .json({ success: false, message: "Resolution failed." });
  }
});

// Hosted-storefront shopper surface (renderer → backend, internal token).
router.get(
  "/api/internal/storefront/config",
  requireInternalToken,
  sfInternal.getConfig,
);
router.get(
  "/api/internal/storefront/catalog",
  requireInternalToken,
  sfInternal.getCatalog,
);
router.get(
  "/api/internal/storefront/products/:productId",
  requireInternalToken,
  sfInternal.getProduct,
);
router.post(
  "/api/internal/storefront/orders",
  requireInternalToken,
  sfInternal.createCheckoutOrder,
);
router.post(
  "/api/internal/storefront/orders/track",
  requireInternalToken,
  sfInternal.trackOrder,
);
router.post(
  "/api/internal/storefront/orders/pay/verify",
  requireInternalToken,
  sfInternal.verifyOrderPaymentEndpoint,
);
router.post(
  "/api/internal/storefront/shoppers/register",
  requireInternalToken,
  sfInternal.shopperRegister,
);
router.post(
  "/api/internal/storefront/shoppers/login",
  requireInternalToken,
  sfInternal.shopperLogin,
);
router.get(
  "/api/internal/storefront/shoppers/me",
  requireInternalToken,
  sfInternal.shopperMe,
);

/**
 * SSL issuance report: the renderer fires this once when it first serves a
 * custom domain over HTTPS (x-forwarded-proto), which is proof the edge has
 * provisioned the certificate. Only flips ssl_status for VERIFIED domains —
 * a domain is "Connected" only after verification AND issuance.
 */
router.post(
  "/api/internal/storefront/ssl-reported",
  requireInternalToken,
  async (req, res) => {
    try {
      const domain = String((req.body as { domain?: unknown })?.domain ?? "")
        .trim()
        .toLowerCase();
      if (!domain) return res.status(400).json({ success: false, message: "domain required." });
      await db
        .update(storefrontDomains)
        .set({ sslStatus: "issued" })
        .where(
          and(
            eq(storefrontDomains.domain, domain),
            eq(storefrontDomains.status, "verified"),
            sql`${storefrontDomains.sslStatus} <> 'issued'`,
          ),
        );
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("SSL report failed:", err);
      return res.status(500).json({ success: false, message: "Report failed." });
    }
  },
);

/**
 * Caddy on_demand_tls ask endpoint: 200 only for hosts we serve — subdomains
 * of the base domain and VERIFIED custom domains. Anything else is 403, so
 * certificates can never be minted for arbitrary hosts.
 *
 * Caddy's ask cannot send custom headers, so the shared token may arrive as
 * a `token` query param (configured in caddy/Caddyfile) or the standard
 * x-internal-token header.
 */
router.get("/api/internal/tls/ask", async (req, res) => {
  try {
    const headerToken = (() => {
      const raw = req.headers["x-internal-token"];
      return (Array.isArray(raw) ? raw[0] : raw) ?? "";
    })();
    const queryToken = String(req.query.token ?? "");
    const provided = Buffer.from(headerToken || queryToken);
    const expected = Buffer.from(env.internalApiToken);
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      return res.status(401).end();
    }

    const host = String(req.query.domain ?? "")
      .trim()
      .toLowerCase()
      .split(":")[0] ?? "";
    if (!host) return res.status(400).end();

    if (host.endsWith(`.${env.storefrontBaseDomain}`)) {
      return res.status(200).end();
    }

    const [row] = await db
      .select({ id: storefrontDomains.id })
      .from(storefrontDomains)
      .where(
        and(
          eq(storefrontDomains.domain, host),
          eq(storefrontDomains.status, "verified"),
        ),
      )
      .limit(1);
    if (row) return res.status(200).end();

    return res.status(403).end();
  } catch (err) {
    console.error("TLS ask endpoint failed:", err);
    return res.status(500).end();
  }
});

export default router;
