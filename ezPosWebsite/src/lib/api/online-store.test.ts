import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchStorefronts,
  createStorefront,
  checkSubdomainAvailability,
  presignMedia,
} from "./online-store";

/**
 * Envelope handling + error paths for the Online Store portal client
 * (same regression surface as portal.test.ts).
 */
describe("online store client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("unwraps {success,data} envelopes for list endpoints", async () => {
    const stores = [{ id: 1, name: "Shop", subdomain: "shop" }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: stores }), {
          status: 200,
        }),
      ),
    );
    const result = await fetchStorefronts(7);
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data?.[0]?.name).toBe("Shop");
    // X-Business-Id header is attached from the argument.
    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(init.headers.get("X-Business-Id")).toBe("7");
  });

  it("creates stores with a JSON body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: { id: 3, name: "New", subdomain: "new" },
          }),
          { status: 201 },
        ),
      ),
    );
    const result = await createStorefront(7, { name: "New", themeId: "aura-fashion" });
    expect(result.ok).toBe(true);
    expect(result.data?.id).toBe(3);
    const [path, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(path)).toContain("/api/businesses/7/storefronts");
    expect(JSON.parse(init.body)).toEqual({ name: "New", themeId: "aura-fashion" });
  });

  it("surfaces backend error messages for 4xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ success: false, message: "That subdomain is already taken." }),
          { status: 409 },
        ),
      ),
    );
    const result = await checkSubdomainAvailability(7, "taken");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.message).toBe("That subdomain is already taken.");
  });

  it("returns a friendly message when the server is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("network down")),
    );
    const result = await presignMedia(7, {
      fileName: "a.png",
      contentType: "image/png",
      sizeBytes: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.message.length).toBeGreaterThan(0);
  });
});
