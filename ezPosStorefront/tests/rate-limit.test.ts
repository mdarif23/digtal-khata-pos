import { afterEach, describe, expect, it } from "vitest";
import { rateLimit, resetRateLimiter } from "../src/lib/rate-limit";

describe("renderer rate limiter", () => {
  afterEach(() => resetRateLimiter());

  it("allows up to the limit within the window, then blocks", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      expect(rateLimit("k", 3, 60_000, now).allowed).toBe(true);
    }
    expect(rateLimit("k", 3, 60_000, now).allowed).toBe(false);
    expect(rateLimit("k", 3, 60_000, now + 1).allowed).toBe(false);
  });

  it("resets after the window elapses and isolates keys", () => {
    const now = 2_000_000;
    rateLimit("a", 1, 60_000, now);
    expect(rateLimit("a", 1, 60_000, now).allowed).toBe(false);
    expect(rateLimit("a", 1, 60_000, now + 60_001).allowed).toBe(true);
    // Independent key is unaffected.
    expect(rateLimit("b", 1, 60_000, now).allowed).toBe(true);
  });
});
