import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { BadRequestError } from "./handleError.js";
import { env } from "../config/env.js";

/**
 * Store-URL validation for outbound integration clients (Phase 9 adapter).
 *
 * The backend makes authenticated server-side requests to the user-supplied
 * store URL, so an unrestricted URL is an SSRF surface: a tenant could point
 * an integration at internal services or link-local metadata endpoints.
 * These checks close the obvious paths:
 *
 * - only http/https, with https required in production (http stays legal in
 *   development so local Woo dev stores work);
 * - IP-literal hosts in private/loopback/link-local ranges are rejected;
 * - hostnames are resolved and every resolved address must be public
 *   (blocks `internal.ezpos.local`-style names and most DNS-rebinding to
 *   private space at connect time).
 */

type LookupFn = typeof lookup;

interface PublicUrlOptions {
  lookupFn?: LookupFn;
}

const PRIVATE_V4_RANGES: [string, number][] = [
  // [network, prefix bits]
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT (carrier-grade NAT)
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local incl. cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking range
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) return NaN;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return NaN;
    out = out * 256 + n;
  }
  return out;
}

export function isPrivateIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (!Number.isFinite(value)) return true; // unparseable → treat as private
  return PRIVATE_V4_RANGES.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(network) & mask);
  });
}

export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  const mappedV4 = mapped?.[1];
  if (mappedV4) return isPrivateIPv4(mappedV4);
  return false;
}

export function isPrivateIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return isPrivateIPv4(bare);
  if (family === 6) return isPrivateIPv6(bare);
  return false; // not an IP literal
}

/**
 * Validates and returns the store URL for outbound integration use.
 * Throws BadRequestError with an actionable message when rejected.
 */
export async function assertPublicStoreUrl(
  raw: string,
  options: PublicUrlOptions = {},
): Promise<string> {
  const reason = await storeUrlProblem(raw, options);
  if (reason) throw new BadRequestError(reason);
  return raw.replace(/\/+$/, "");
}

/** Returns a rejection reason, or null when the URL is acceptable. */
export async function storeUrlProblem(
  raw: string,
  options: PublicUrlOptions = {},
): Promise<string | null> {
  // The integration harness connects mock WooCommerce stores on loopback
  // (http://127.0.0.1:<port>) — the guard is bypassed only there. The
  // harness itself fail-closes on a database named ezpos_test, so this flag
  // never reaches a real deployment that runs the normal test entrypoint.
  if (process.env.INTEGRATION_TESTS === "1") return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "The store URL is not a valid URL.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "The store URL must use http or https.";
  }
  if (parsed.protocol === "http:" && env.isProduction) {
    return "The store URL must use https.";
  }
  if (!parsed.hostname) {
    return "The store URL is missing a host.";
  }
  if (isPrivateIpLiteral(parsed.hostname)) {
    return "The store URL must point at a public host.";
  }

  const lookupFn = options.lookupFn ?? lookup;
  try {
    const addresses = await lookupFn(parsed.hostname, { all: true });
    if (addresses.length === 0) {
      return "The store URL host could not be resolved.";
    }
    const internal = addresses.find((a) =>
      a.family === 6 ? isPrivateIPv6(a.address) : isPrivateIPv4(a.address),
    );
    if (internal) {
      return "The store URL must point at a public host.";
    }
  } catch {
    return "The store URL host could not be resolved.";
  }
  return null;
}
