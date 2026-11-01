import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertPublicStoreUrl,
  isPrivateIpLiteral,
  isPrivateIPv4,
  isPrivateIPv6,
  storeUrlProblem,
} from "./validateStoreUrl.js";

// These unit tests exercise the real guard logic; make them immune to being
// run alongside the integration suites (which set INTEGRATION_TESTS=1 and
// bypass the guard for loopback mock stores).
delete process.env.INTEGRATION_TESTS;

describe("private IP classification", () => {
  it("classifies private, loopback, link-local and reserved IPv4 as private", () => {
    for (const ip of [
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254", // cloud metadata
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "240.0.0.1",
    ]) {
      assert.equal(isPrivateIPv4(ip), true, ip);
    }
  });

  it("classifies public IPv4 as public", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "9.9.9.9"]) {
      assert.equal(isPrivateIPv4(ip), false, ip);
    }
  });

  it("classifies IPv6 loopback, link-local and ULA as private, incl. v4-mapped", () => {
    assert.equal(isPrivateIPv6("::1"), true);
    assert.equal(isPrivateIPv6("fe80::1"), true);
    assert.equal(isPrivateIPv6("fd00::1"), true);
    assert.equal(isPrivateIPv6("::ffff:127.0.0.1"), true);
    assert.equal(isPrivateIPv6("::ffff:8.8.8.8"), false);
  });

  it("detects IP-literal hosts (bracketed or bare)", () => {
    assert.equal(isPrivateIpLiteral("127.0.0.1"), true);
    assert.equal(isPrivateIpLiteral("[::1]"), true);
    assert.equal(isPrivateIpLiteral("example.com"), false);
  });
});

describe("storeUrlProblem", () => {
  const okLookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;

  /** Non-null helper so assert.match gets a string. */
  async function problemOf(url: string, lookupFn?: never) {
    const problem = await storeUrlProblem(url, lookupFn ? { lookupFn } : {});
    assert.ok(problem, `expected ${url} to be rejected`);
    return problem;
  }

  it("rejects non-http(s) schemes", async () => {
    assert.match(await problemOf("ftp://example.com"), /http or https/);
    assert.match(await problemOf("file:///etc/passwd"), /http or https/);
  });

  it("rejects private IP-literal hosts without DNS", async () => {
    assert.match(await problemOf("http://169.254.169.254/wp-json"), /public host/);
    assert.match(await problemOf("http://127.0.0.1:8080/wp-json"), /public host/);
    assert.match(await problemOf("http://[fd00::1]/wp-json"), /public host/);
  });

  it("rejects hostnames that resolve into private ranges", async () => {
    const internalLookup = (async () => [
      { address: "10.0.0.5", family: 4 },
    ]) as never;
    assert.match(
      await problemOf("https://internal.corp/wp-json", internalLookup),
      /public host/,
    );
  });

  it("accepts a public https URL", async () => {
    assert.equal(
      await storeUrlProblem("https://shop.example.com/wp-json", {
        lookupFn: okLookup,
      }),
      null,
    );
  });

  it("rejects unresolvable hosts", async () => {
    const failLookup = (async () => {
      throw new Error("ENOTFOUND");
    }) as never;
    assert.match(
      await problemOf("https://no-such-host.invalid", failLookup),
      /could not be resolved/,
    );
  });
});

describe("assertPublicStoreUrl", () => {
  it("returns the normalized URL (trailing slashes stripped) when public", async () => {
    const url = await assertPublicStoreUrl("https://shop.example.com///", {
      lookupFn: (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
    });
    assert.equal(url, "https://shop.example.com");
  });

  it("throws BadRequestError with the reason when rejected", async () => {
    await assert.rejects(
      assertPublicStoreUrl("http://10.0.0.1", {
        lookupFn: (async () => [{ address: "10.0.0.1", family: 4 }]) as never,
      }),
      /public host/,
    );
  });
});
