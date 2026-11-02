/**
 * Real-time register updates integration tests (Module 11): ticket minting,
 * one-time ticket enforcement, and actual event delivery over SSE.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("realtime register updates integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";

  before(async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const db = await client.query("SELECT current_database() AS db");
    if (db.rows[0]?.db !== "ezpos_test") {
      await client.end();
      throw new Error(
        `SAFETY ABORT: connected to "${db.rows[0]?.db}" — integration tests may only run against ezpos_test.`,
      );
    }
    await client.query(
      `INSERT INTO subscription_plans (name, slug, interval, price, currency, is_active)
       VALUES ('Free trial', 'free-trial', 'monthly', 0, 'BDT', true)
       ON CONFLICT (slug) DO UPDATE
       SET limits = NULL,
           features = '{"multiLocation":true,"advancedReports":true,"storefrontApi":true,"woocommerceIntegration":true,"customStorefront":true,"multipleOnlineStores":true,"advancedWebhooks":true}'::jsonb,
           is_active = true`,
    );
    await client.end();
    const { ensureRbacSeed } = await import("../rbac/seed.js");
    await ensureRbacSeed();

    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(() => {
    server?.close();
  });

  const uniqueEmail = () =>
    `realtime-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let locationId = 0;

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Realtime Test", email, password: "strong-password-123" }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    token = ((await login.json()) as { accessToken: string }).accessToken;
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: `Realtime Biz ${Date.now()}` }),
    });
    businessId = ((await biz.json()) as { business: { id: number } }).business.id;
    const loc = await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
      },
      body: JSON.stringify({ name: "Main Store" }),
    });
    locationId = ((await loc.json()) as { data: { id: number } }).data.id;
  });

  async function mintTicket(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/realtime/ticket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
        "X-Location-Id": String(locationId),
      },
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as { data: { ticket: string } }).data.ticket;
  }

  it("rejects a stream opened without a ticket", async () => {
    const res = await fetch(`${baseUrl}/api/realtime/stream`);
    assert.equal(res.status, 401);
  });

  it("rejects a replayed one-time ticket", async () => {
    const ticket = await mintTicket();
    const first = await fetch(`${baseUrl}/api/realtime/stream?ticket=${ticket}`);
    assert.equal(first.status, 200);
    await first.body?.cancel();
    const second = await fetch(`${baseUrl}/api/realtime/stream?ticket=${ticket}`);
    assert.equal(second.status, 401);
    await second.body?.cancel();
  });

  it("delivers published events to a connected stream at the same location", async () => {
    const ticket = await mintTicket();
    const stream = await fetch(
      `${baseUrl}/api/realtime/stream?ticket=${ticket}`,
    );
    assert.equal(stream.status, 200);

    // Read the stream in the background until we see our event.
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const readPromise = (async () => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
        if (received.includes("sale.created")) break;
      }
    })();

    // Give the stream a moment to register, then publish directly through
    // the service (same process — the registry is in memory).
    await new Promise((resolve) => setTimeout(resolve, 150));
    const { publishRealtime } = await import(
      "../modules/realtime/realtime.service.js"
    );
    publishRealtime(businessId, locationId, {
      kind: "sale.created",
      locationId,
      saleId: 1,
    });
    // A different location's register must NOT receive it.
    publishRealtime(businessId, locationId + 999, {
      kind: "sale.created",
      locationId: locationId + 999,
      saleId: 2,
    });

    await readPromise;
    await reader.cancel();
    assert.ok(received.includes(": connected"));
    assert.ok(received.includes("sale.created"));
    assert.ok(received.includes(`"saleId":1`));
    assert.ok(!received.includes(`"saleId":2`), "must not receive other locations' events");
  });
});
