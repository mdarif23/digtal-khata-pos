/**
 * Fixed-window per-key rate limiter for renderer bridge routes. In-memory,
 * per process — the same single-instance constraint as the backend's
 * limiter (documented; a shared store arrives with horizontal scaling).
 */
const windows = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): { allowed: boolean; remaining: number } {
  // Opportunistic cleanup so the map cannot grow without bound.
  if (windows.size > 10_000) {
    for (const [k, entry] of windows) {
      if (entry.resetAt <= now) windows.delete(k);
    }
  }
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1 };
  }
  if (existing.count >= limit) {
    return { allowed: false, remaining: 0 };
  }
  existing.count += 1;
  return { allowed: true, remaining: limit - existing.count };
}

/** Test helper: clear all windows. */
export function resetRateLimiter(): void {
  windows.clear();
}

/** Best-effort client IP for limiter keys (behind the edge proxy). */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}
