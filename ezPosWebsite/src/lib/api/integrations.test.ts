import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStorefrontKeys } from "./integrations";
import { fetchWebhookEndpoints } from "./webhooks";

/**
 * Regression: gated endpoints (403 PLAN_LIMIT/feature) return a failure
 * envelope WITHOUT a data key. The old unwrap passed the whole error object
 * through as `data`, so list components crashed on `.map is not a function`.
 * The fix: failures carry ok=false, the server message, and NO data.
 */
describe("integrations/webhooks clients — failure envelopes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchStorefrontKeys: 403 envelope returns ok=false and NO data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            message: "This plan does not include storefront API access.",
          }),
          { status: 403 },
        ),
      ),
    );
    const result = await fetchStorefrontKeys(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.message).toBe(
      "This plan does not include storefront API access.",
    );
    expect(result.data).toBeUndefined();
  });

  it("fetchWebhookEndpoints: 403 envelope returns ok=false and NO data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            message: "This plan does not include advanced webhooks.",
          }),
          { status: 403 },
        ),
      ),
    );
    const result = await fetchWebhookEndpoints(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.data).toBeUndefined();
  });

  it("still unwraps {success,data} envelopes on success", async () => {
    const keys = [
      { id: 3, name: "K", publishableKey: "ezpos_pk_x", scopes: [], createdAt: "" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: keys }), {
          status: 200,
        }),
      ),
    );
    const result = await fetchStorefrontKeys(1);
    expect(result.ok).toBe(true);
    expect(result.data?.[0]?.id).toBe(3);
  });
});
