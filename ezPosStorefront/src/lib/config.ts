import "server-only";

/**
 * Server-side configuration for the storefront renderer.
 * Fail-fast in production when the internal token is missing.
 */
export const serverConfig = {
  backendUrl: process.env.BACKEND_URL?.trim() || "http://localhost:3000",
  internalToken:
    process.env.STOREFRONT_RENDERER_TOKEN?.trim() ||
    (process.env.NODE_ENV === "production"
      ? ""
      : "ezpos-local-development-internal-token"),
  baseDomain:
    process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN?.trim().toLowerCase() ||
    "ezpos.store",
  /** Dev convenience: resolve this subdomain when browsing via localhost. */
  devSubdomain: process.env.STOREFRONT_DEV_SUBDOMAIN?.trim() || "",
};

/**
 * The internal token is validated at REQUEST time, not module load —
 * `next build` runs with NODE_ENV=production before runtime env (docker)
 * is present.
 */
export function requireInternalToken(): string {
  if (!serverConfig.internalToken) {
    throw new Error(
      "STOREFRONT_RENDERER_TOKEN is required in production — it authenticates every backend call.",
    );
  }
  return serverConfig.internalToken;
}
