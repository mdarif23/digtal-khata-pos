import "server-only";
import { headers } from "next/headers";
import { fetchTenantConfig, type TenantConfig } from "./backend";
import { serverConfig } from "./config";

/**
 * Tenant resolution for render code.
 *
 * `proxy.ts` resolves the HOST once per request and attaches
 * `x-storefront-id` (+ preview mode). Render code reads those headers and
 * loads the tenant payload with a short server cache — unknown hosts never
 * reach these routes (they are rewritten to /parked by the proxy).
 */

export const STOREFRONT_ID_HEADER = "x-storefront-id";
export const PREVIEW_QUERY_PARAM = "preview";

export interface Tenant {
  config: TenantConfig;
  /** Absolute origin shoppers see (scheme + resolved host). */
  origin: string;
}

function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost")
  );
}

/**
 * The host to resolve for the current request. On localhost (development)
 * the configured dev subdomain is used instead, so the renderer can be
 * exercised without DNS.
 */
export async function resolveRequestHost(): Promise<string> {
  const headerList = await headers();
  const host = (headerList.get("host") ?? "")
    .toLowerCase()
    .split(":")[0] ?? "";
  if (isLocalHost(host) && serverConfig.devSubdomain) {
    return `${serverConfig.devSubdomain}.${serverConfig.baseDomain}`;
  }
  return host;
}

/**
 * Loads the current tenant (headers → config endpoint). Returns null when
 * no tenant is attached (e.g. the parked page) or the store is offline.
 */
export async function getTenant(): Promise<Tenant | null> {
  const headerList = await headers();
  const storefrontId = Number(headerList.get(STOREFRONT_ID_HEADER) ?? "");
  if (!Number.isInteger(storefrontId) || storefrontId <= 0) return null;

  // Preview tokens arrive as a query parameter and are forwarded by the proxy
  // via header so server components and metadata see the same mode.
  const preview = headerList.get("x-storefront-preview") ?? undefined;
  const config = await fetchTenantConfig(storefrontId, preview || undefined);
  if (!config || !config.available) return null;

  const proto = headerList.get("x-forwarded-proto") ?? "http";
  const host = await resolveRequestHost();
  return { config, origin: `${proto}://${host}` };
}

export function tenantStoreUrl(subdomain: string): string {
  return `https://${subdomain}.${serverConfig.baseDomain}`;
}
