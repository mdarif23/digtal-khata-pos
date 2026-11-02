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

async function resolveHost(host: string, preview: string): Promise<number | null> {
  const cacheKey = `${host}|${preview ? "preview" : "live"}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.storefrontId;

  let storefrontId: number | null = null;
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
        data?: { resolved?: boolean; storefront?: { storefrontId?: number } };
      };
      storefrontId = body?.data?.resolved
        ? (body.data.storefront?.storefrontId ?? null)
        : null;
    }
  } catch {
    storefrontId = null;
  }

  cache.set(cacheKey, {
    storefrontId,
    expiresAt:
      Date.now() + (storefrontId === null ? NEGATIVE_TTL_MS : RESOLVE_TTL_MS),
  });
  if (cache.size > 5000) {
    for (const [key, entry] of cache) {
      if (entry.expiresAt < Date.now()) cache.delete(key);
    }
  }
  return storefrontId;
}

export async function proxy(request: NextRequest) {
  const rawHost = (request.headers.get("host") ?? "")
    .toLowerCase()
    .split(":")[0] ?? "";
  const preview = request.nextUrl.searchParams.get("preview") ?? "";

  let host = rawHost;
  if (isLocalHost(rawHost)) {
    const devSubdomain = process.env.STOREFRONT_DEV_SUBDOMAIN?.trim();
    if (devSubdomain) {
      const base =
        process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN?.trim().toLowerCase() ||
        "ezpos.store";
      host = `${devSubdomain}.${base}`;
    } else {
      // No dev tenant configured: render the parked page locally.
      return NextResponse.rewrite(new URL("/parked", request.url));
    }
  }

  const storefrontId = await resolveHost(host, preview);
  if (storefrontId === null) {
    return NextResponse.rewrite(new URL("/parked", request.url));
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
