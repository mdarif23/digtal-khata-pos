/**
 * Phase 9.2 integration tests: storefront API — key lifecycle, scoped
 * auth, catalog contract (no cost leakage), availability, idempotent
 * order submission, cross-tenant isolation, rate limiting — against a
 * REAL PostgreSQL database with the business-mode gate enforced.
 * Double-guarded like the other suites.
 *
 * Plain `npm test` NEVER runs this file.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("storefront api integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let pg: import("pg").Client | null = null;

  before(async () => {
    const { default: pgDefault } = await import("pg");
    const client = new pgDefault.Client({
      connectionString: process.env.DATABASE_URL,
    });
    await client.connect();
    const db = await client.query("SELECT current_database() AS db");
    if (db.rows[0]?.db !== "ezpos_test") {
      await client.end();
      throw new Error(
        `SAFETY ABORT: connected to "${db.rows[0]?.db}" — integration tests may only run against ezpos_test.`,
      );
    }
    pg = client;
    await ensureRbacSeed();

    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server?.close();
    await pg?.end();
    pg = null;
  });

  let counter = 0;
  const uniqueEmail = () =>
    `sf-${Date.now()}-${(counter += 1)}@example.test`;

  interface Ctx {
    token: string;
    businessId: number;
    userId: number;
    email: string;
  }

  async function api(
    ctx: Ctx,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.token}`,
        "X-Business-Id": String(ctx.businessId),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  async function createOwnerCtx(businessName: string): Promise<Ctx> {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Storefront Test",
        email,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    const loginBody = (await login.json()) as {
      accessToken: string;
      user: { id: number };
    };
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginBody.accessToken}`,
      },
      body: JSON.stringify({ name: businessName }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business: { id: number } };
    // Default location — storefront stock lives here.
    const loc = await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginBody.accessToken}`,
        "X-Business-Id": String(bizBody.business.id),
      },
      body: JSON.stringify({ name: "Main Store" }),
    });
    assert.equal(loc.status, 201);
    return {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
      email,
    };
  }

  async function setMode(ctx: Ctx, mode: string): Promise<void> {
    const res = await api(ctx, "PATCH", `/api/businesses/${ctx.businessId}/mode`, {
      mode,
    });
    assert.equal(res.status, 200);
  }

  async function createKey(
    ctx: Ctx,
    options: {
      scopes?: string[];
      allowedDomains?: string[];
      name?: string;
    } = {},
  ): Promise<{ id: number; publishableKey: string; secretKey: string }> {
    const res = await api(
      ctx,
      "POST",
      `/api/businesses/${ctx.businessId}/storefront/keys`,
      {
        name: options.name ?? "Test key",
        scopes: options.scopes ?? [
          "products:read",
          "inventory:read",
          "orders:read",
          "orders:write",
        ],
        allowedDomains: options.allowedDomains,
      },
    );
    assert.equal(res.status, 201);
    return res.body.data;
  }

  async function seedVariant(
    businessId: number,
    qty: number,
    price = 100,
  ): Promise<number> {
    counter += 1;
    const location = (await pg!.query(
      "SELECT id FROM locations WHERE business_id = $1 AND is_default = true",
      [businessId],
    )).rows[0] as { id: number } | undefined;
    assert.ok(location, "default location missing");
    const product = await pg!.query(
      `INSERT INTO products (business_id, name, description, product_type, tracking_type, status)
       VALUES ($1, $2, 'Storefront product description', 'physical', 'none', 'active') RETURNING id`,
      [businessId, `Storefront Product ${counter}`],
    );
    const variant = await pg!.query(
      `INSERT INTO product_variants (business_id, product_id, sku, selling_price, is_default, status)
       VALUES ($1, $2, $3, $4, true, 'active') RETURNING id`,
      [businessId, product.rows[0]!.id, `SF-${Date.now()}-${counter}`, price],
    );
    await pg!.query(
      `INSERT INTO inventory_stock (business_id, variant_id, location_id, quantity, reserved_quantity)
       VALUES ($1, $2, $3, $4, 0)`,
      [businessId, variant.rows[0]!.id, location.id, qty],
    );
    await pg!.query(
      `INSERT INTO product_images (business_id, product_id, image_url, sort_order)
       VALUES ($1, $2, $3, 0)`,
      [businessId, product.rows[0]!.id, `https://cdn.example.test/img-${counter}.jpg`],
    );
    return variant.rows[0]!.id as number;
  }

  function sfGet(
    key: string,
    path: string,
    origin?: string,
  ): Promise<{ status: number; body: any }> {
    return fetch(`${baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        ...(origin ? { Origin: origin } : {}),
      },
    }).then(async (res) => ({
      status: res.status,
      body: await res.json().catch(() => null),
    }));
  }

  function sfPost(key: string, path: string, body: unknown, idempotencyKey?: string) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    }).then(async (res) => ({
      status: res.status,
      body: await res.json().catch(() => null),
    }));
  }

  it("creates keys: secret shown once, listing never contains it, revocation is immediate", async () => {
    const owner = await createOwnerCtx("SF Keys Co");
    await setMode(owner, "omnichannel");

    const created = await createKey(owner);
    assert.match(created.publishableKey, /^ezpos_pk_/);
    assert.match(created.secretKey, /^ezpos_sk_/);

    const list = await api(
      owner,
      "GET",
      `/api/businesses/${owner.businessId}/storefront/keys`,
    );
    assert.equal(list.status, 200);
    const listed = (list.body.data as { id: number; publishableKey: string }[]).find(
      (k) => k.id === created.id,
    );
    assert.ok(listed);
    assert.equal(listed.publishableKey, created.publishableKey);
    assert.equal(JSON.stringify(list.body.data).includes(created.secretKey), false);

    // Revoke → the key stops working immediately.
    const revoke = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefront/keys/${created.id}/revoke`,
    );
    assert.equal(revoke.status, 200);
    const denied = await sfGet(created.secretKey, "/api/v1/storefront/products");
    assert.equal(denied.status, 401);
  });

  it("rejects requests without/with-invalid keys and gates by business mode", async () => {
    const owner = await createOwnerCtx("SF Gate Co");
    await setMode(owner, "omnichannel");
    const key = await createKey(owner);

    const noKey = await sfGet("", "/api/v1/storefront/products");
    assert.equal(noKey.status, 401);

    const badKey = await sfGet("ezpos_sk_deadbeef", "/api/v1/storefront/products");
    assert.equal(badKey.status, 401);

    // Physical-only businesses have no storefront surface.
    await setMode(owner, "physical_only");
    const physical = await sfGet(key.publishableKey, "/api/v1/storefront/products");
    assert.equal(physical.status, 403);

    // Back to omnichannel for the other tests in this file.
    await setMode(owner, "omnichannel");
    const ok = await sfGet(key.publishableKey, "/api/v1/storefront/products");
    assert.equal(ok.status, 200);
  });

  it("serves the catalog with availability and never leaks cost or supplier data", async () => {
    const owner = await createOwnerCtx("SF Catalog Co");
    await setMode(owner, "omnichannel");
    const variantId = await seedVariant(owner.businessId, 7, 250);
    const key = await createKey(owner);
    const both = `${key.publishableKey}`;

    const list = await sfGet(both, "/api/v1/storefront/products?pageSize=50");
    assert.equal(list.status, 200);
    const product = (list.body.products as {
      id: number;
      name: string;
      variants: { id: number; price: number; availability: number }[];
      images: string[];
      description: string;
    }[]).find((p) => p.variants.some((v) => v.id === variantId));
    assert.ok(product, "seeded product not returned");
    assert.equal(product.variants[0]!.price, 250);
    assert.equal(product.variants[0]!.availability, 7);
    assert.equal(product.images.length, 1);
    // Contract: no internal fields ever leave.
    const serialized = JSON.stringify(list.body);
    assert.equal(/purchase|cost|supplier/i.test(serialized), false);

    // Search narrows.
    const search = await sfGet(
      both,
      `/api/v1/storefront/products?search=${encodeURIComponent(product.name)}`,
    );
    assert.equal(search.status, 200);
    assert.equal(search.body.total, 1);

    // Detail + availability endpoints.
    const detail = await sfGet(both, `/api/v1/storefront/products/${product.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.id, product.id);
    const availability = await sfGet(
      both,
      `/api/v1/storefront/inventory?variantIds=${variantId}`,
    );
    assert.equal(availability.body.data.availability[variantId], 7);
  });

  it("publishable keys cannot submit orders; scopes are enforced", async () => {
    const owner = await createOwnerCtx("SF Scopes Co");
    await setMode(owner, "omnichannel");
    const readOnlyKey = await createKey(owner, {
      scopes: ["products:read", "inventory:read"],
      name: "read-only",
    });
    const variantId = await seedVariant(owner.businessId, 5);

    const denied = await sfPost(
      readOnlyKey.publishableKey,
      "/api/v1/storefront/orders",
      { lines: [{ variantId, quantity: 1 }], customer: { name: "X" } },
      "idempotency-scopes-1",
    );
    assert.equal(denied.status, 403);

    // A secret key without orders:write is also denied.
    const secretNoWrite = await createKey(owner, {
      scopes: ["products:read", "orders:read"],
      name: "no-write",
    });
    const denied2 = await sfPost(
      secretNoWrite.secretKey,
      "/api/v1/storefront/orders",
      { lines: [{ variantId, quantity: 1 }], customer: { name: "X" } },
      "idempotency-scopes-2",
    );
    assert.equal(denied2.status, 403);
    void variantId;
  });

  it("submits orders idempotently and isolates cross-tenant reads", async () => {
    const ownerA = await createOwnerCtx("SF Orders A");
    await setMode(ownerA, "omnichannel");
    const ownerB = await createOwnerCtx("SF Orders B");
    await setMode(ownerB, "omnichannel");
    const variantA = await seedVariant(ownerA.businessId, 10);
    const keyA = await createKey(ownerA);
    const keyB = await createKey(ownerB);

    const idempotencyKey = `sf-orders-idem-${Date.now()}`;
    const payload = {
      lines: [{ variantId: variantA, quantity: 2 }],
      customer: { name: "Web Buyer", phone: "+8801700111222" },
      externalOrderId: "WC-1001",
    };

    const missingHeader = await sfPost(
      keyA.secretKey,
      "/api/v1/storefront/orders",
      payload,
    );
    assert.equal(missingHeader.status, 400);

    const first = await sfPost(
      keyA.secretKey,
      "/api/v1/storefront/orders",
      payload,
      idempotencyKey,
    );
    assert.equal(first.status, 201);
    assert.equal(first.body.data.status, "pending");
    const orderId = first.body.data.orderId as number;

    // Duplicate idempotency key → same order, flagged duplicated.
    const duplicate = await sfPost(
      keyA.secretKey,
      "/api/v1/storefront/orders",
      payload,
      idempotencyKey,
    );
    assert.equal(duplicate.body.data.duplicated, true);
    assert.equal(duplicate.body.data.orderId, orderId);

    // B's key cannot see A's order.
    const foreign = await sfGet(keyB.secretKey, `/api/v1/storefront/orders/${orderId}`);
    assert.equal(foreign.status, 404);

    // Status endpoint reflects the created order for the owner key.
    const status = await sfGet(keyA.secretKey, `/api/v1/storefront/orders/${orderId}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.data.status, "pending");

    // Availability dropped by the reservation.
    const availability = await sfGet(
      keyA.publishableKey,
      `/api/v1/storefront/inventory?variantIds=${variantA}`,
    );
    assert.equal(availability.body.data.availability[variantA], 8);
  });

  it("publishable keys honor domain restrictions", async () => {
    const owner = await createOwnerCtx("SF Domains Co");
    await setMode(owner, "omnichannel");
    const restricted = await createKey(owner, {
      scopes: ["products:read"],
      allowedDomains: ["https://shop.example.test"],
      name: "domain-locked",
    });

    const allowed = await sfGet(
      restricted.publishableKey,
      "/api/v1/storefront/products",
      "https://shop.example.test",
    );
    assert.equal(allowed.status, 200);

    const denied = await sfGet(
      restricted.publishableKey,
      "/api/v1/storefront/products",
      "https://evil.example.test",
    );
    assert.equal(denied.status, 403);
  });

  it("rate-limits per key", async () => {
    const owner = await createOwnerCtx("SF Rate Co");
    await setMode(owner, "omnichannel");
    const key = await createKey(owner, { name: "rate" });
    // The limiter is in-memory; hammering past the configured per-minute
    // ceiling must eventually produce 429 (env-tunable for tests).
    const limit = Number(process.env.STOREFRONT_RATE_LIMIT_PER_MINUTE ?? 600);
    let sawLimited = false;
    for (let i = 0; i < limit + 5; i += 1) {
      const res = await fetch(`${baseUrl}/api/v1/storefront/products`, {
        headers: { Authorization: `Bearer ${key.publishableKey}` },
      });
      if (res.status === 429) {
        sawLimited = true;
        break;
      }
    }
    assert.equal(sawLimited, true);
  });
});
