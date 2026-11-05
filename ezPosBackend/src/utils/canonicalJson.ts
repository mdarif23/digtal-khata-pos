import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialization: object keys sorted recursively,
 * `undefined` values dropped (matching JSON.stringify semantics), arrays
 * order-preserving. Two structurally equal payloads always produce the same
 * string regardless of client key order — the basis for binding an
 * idempotency key to its payload (multi-terminal Phase 1).
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`)
    .join(",")}}`;
}

export function sha256OfJson(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJsonStringify(value))
    .digest("hex");
}
