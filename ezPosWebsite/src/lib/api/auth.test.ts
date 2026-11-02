import { afterEach, describe, it, vi, expect } from "vitest";
import {
  signIn,
  signOut,
  signUp,
  getAccessToken,
  SERVER_UNREACHABLE_MESSAGE,
} from "./auth";

/**
 * Unit tests for the auth client's token lifecycle. The access token lives
 * in module state — tests sign in/out to drive it. Fetch is stubbed so no
 * network happens.
 */
describe("auth client", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await signOut();
  });

  it("signIn stores the access token on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ accessToken: "tok-123", user: { id: 1 } }),
          { status: 200 },
        ),
      ),
    );
    const result = await signIn({ email: "a@b.c", password: "pw" });
    expect(result.ok).toBe(true);
    expect(getAccessToken()).toBe("tok-123");
  });

  it("signIn clears the token on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Invalid credentials" }), {
          status: 401,
        }),
      ),
    );
    const result = await signIn({ email: "a@b.c", password: "wrong" });
    expect(result.ok).toBe(false);
    expect(getAccessToken()).toBeNull();
  });

  it("reports unreachable servers with the friendly message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const result = await signIn({ email: "a@b.c", password: "pw" });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(SERVER_UNREACHABLE_MESSAGE);
  });

  it("signOut clears the token even when the server call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ accessToken: "tok" }), { status: 200 }),
      ),
    );
    await signIn({ email: "a@b.c", password: "pw" });
    expect(getAccessToken()).not.toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await signOut();
    expect(getAccessToken()).toBeNull();
  });

  it("signUp returns the duplicate-account message from the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ message: "An account with this email already exists." }),
          { status: 409 },
        ),
      ),
    );
    const result = await signUp({
      fullName: "Test",
      email: "a@b.c",
      password: "pw",
      termsAccepted: true,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.message).toMatch(/already exists/i);
  });
});
