import { NextResponse, type NextRequest } from "next/server";

/**
 * Tenant resolution at the edge of the renderer (Next 16 `proxy` — the
 * successor of middleware).
 *
 * - Resolves the incoming HOST against the backend's internal endpoint
 *   (short in-process cache; negative results cached too).
 * - Resolved tenants get `x-storefront-id` (+ preview mode) request headers
 *   for the render.
 * - Anything unresolvable is rewritten to /parked — host-header attacks and
 *   dangling DNS land on the same branded page, never on another tenant.
 */

const RESOLVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 30_000;

interface ResolveEntry {
  storefrontId: number | null;
  /** The tenant's canonical host (for 301 redirects); null when unresolved. */
  primaryDomain: string | null;
  expiresAt: number;
}

const cache = new Map<string, ResolveEntry>();

function backendUrl(): string {
  return process.env.BACKEND_URL?.trim() || "http://localhost:3000";
}

function internalToken(): string {
  return (
    process.env.STOREFRONT_RENDERER_TOKEN?.trim() ||
    (process.env.NODE_ENV === "production"
      ? ""
      : "ezpos-local-development-internal-token")
  );
}

function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost")
  );
}

async function resolveHost(
  host: string,
  preview: string,
): Promise<{ storefrontId: number | null; primaryDomain: string | null }> {
  const cacheKey = `${host}|${preview ? "preview" : "live"}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { storefrontId: cached.storefrontId, primaryDomain: cached.primaryDomain };
  }

  let storefrontId: number | null = null;
  let primaryDomain: string | null = null;
  try {
    const query = new URLSearchParams({ host });
    if (preview) query.set("preview", preview);
    const res = await fetch(
      `${backendUrl()}/api/internal/storefront/resolve?${query.toString()}`,
      {
        headers: { "x-internal-token": internalToken() },
        cache: "no-store",
      },
    );
    if (res.ok) {
      const body = (await res.json()) as {
        data?: {
          resolved?: boolean;
          storefront?: { storefrontId?: number; primaryDomain?: string | null };
        };
      };
      if (body?.data?.resolved) {
        storefrontId = body.data.storefront?.storefrontId ?? null;
        primaryDomain = body.data.storefront?.primaryDomain ?? null;
      }
    }
  } catch {
    storefrontId = null;
  }

  cache.set(cacheKey, {
    storefrontId,
    primaryDomain,
    expiresAt:
      Date.now() + (storefrontId === null ? NEGATIVE_TTL_MS : RESOLVE_TTL_MS),
  });
  if (cache.size > 5000) {
    for (const [key, entry] of cache) {
      if (entry.expiresAt < Date.now()) cache.delete(key);
    }
  }
  return { storefrontId, primaryDomain };
}

/** Best-effort: proves the edge issued the tenant's certificate. Fires at
 *  most once per host per process (the backend update is a no-op afterwards). */
const sslReported = new Set<string>();
function reportSslIssued(host: string): void {
  if (sslReported.has(host)) return;
  sslReported.add(host);
  void fetch(`${backendUrl()}/api/internal/storefront/ssl-reported`, {
    method: "POST",
    headers: { "x-internal-token": internalToken(), "Content-Type": "application/json" },
    body: JSON.stringify({ domain: host }),
    cache: "no-store",
  }).catch(() => undefined);
}

export async function proxy(request: NextRequest) {
  const rawHost = (request.headers.get("host") ?? "")
    .toLowerCase()
    .split(":")[0] ?? "";
  const preview = request.nextUrl.searchParams.get("preview") ?? "";

  let host = rawHost;
  let isLocalDev = false;
  if (isLocalHost(rawHost)) {
    const devSubdomain = process.env.STOREFRONT_DEV_SUBDOMAIN?.trim();
    if (devSubdomain) {
      const base =
        process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN?.trim().toLowerCase() ||
        "ezpos.store";
      host = `${devSubdomain}.${base}`;
      isLocalDev = true;
    } else {
      // No dev tenant configured: render the parked page locally.
      return NextResponse.rewrite(new URL("/parked", request.url));
    }
  }

  const { storefrontId, primaryDomain } = await resolveHost(host, preview);
  if (storefrontId === null) {
    return NextResponse.rewrite(new URL("/parked", request.url));
  }

  // Canonical-host redirect: send every non-primary host of this tenant to
  // the primary domain (preserving path/query). Never applied in preview
  // mode or local development.
  if (
    !preview &&
    !isLocalDev &&
    primaryDomain &&
    host !== primaryDomain
  ) {
    const target = new URL(request.nextUrl);
    target.protocol = "https:";
    target.host = primaryDomain;
    return NextResponse.redirect(target, 301);
  }

  // First HTTPS request for a domain proves the certificate exists.
  if (!isLocalDev && request.headers.get("x-forwarded-proto") === "https") {
    reportSslIssued(host);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-storefront-id", String(storefrontId));
  if (preview) requestHeaders.set("x-storefront-preview", preview);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: [
    // Everything except Next internals, API routes and the parked page itself.
    "/((?!_next/static|_next/image|api/|parked|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
