import { beforeEach, afterEach, describe, it, vi, expect } from "vitest";
import { fetchInvoices, changePlan } from "./portal";
import { fetchSubscription } from "./account";

/**
 * Regression tests for the response-envelope handling. The portal clients
 * previously passed the whole `{ success, data }` body through as `data`,
 * which crashed the overview page (invoices.slice is not a function).
 */
describe("portal client response unwrapping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("unwraps {success,data} envelopes for list endpoints", async () => {
    const invoices = [{ id: 1, invoiceNumber: "INV-1" }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: invoices }),
          { status: 200 },
        ),
      ),
    );
    const result = await fetchInvoices(1);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(invoices);
    expect(Array.isArray(result.data)).toBe(true);
  });

  it("passes field-style payloads through unchanged", async () => {
    const body = {
      success: true,
      subscription: { status: "active", accessMode: "full" },
      plan: { id: 2, name: "Professional" },
      usage: { users: 1, locations: 1, products: 3 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), { status: 200 }),
      ),
    );
    const result = await fetchSubscription(5);
    expect(result.ok).toBe(true);
    // Field-style responses keep the full body as data.
    expect(result.data?.subscription).toEqual(body.subscription);
    expect(result.data?.plan).toEqual(body.plan);
  });

  it("extracts the error message from failure envelopes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ success: false, message: "Plan limit reached." }),
          { status: 403 },
        ),
      ),
    );
    const result = await changePlan(1, 9);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Plan limit reached.");
  });

  it("reports unreachable servers with the friendly message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const result = await fetchInvoices(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });
});
