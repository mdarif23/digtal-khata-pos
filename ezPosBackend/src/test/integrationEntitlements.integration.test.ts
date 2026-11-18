/**
 * Phase 9.6 integration tests: integration entitlements — feature gates on
 * connect/key/webhook creation, connected-store and webhook limits, and
 * pause-on-expiry for sync pushes. Double-guarded like the other suites.
 *
 * Plain `npm test` NEVER runs this file.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";
import { pushProducts } from "../modules/integrations/integrations.service.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("integration entitlements", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let pg: import("pg").Client | null = null;

  let wcServer: import("node:http").Server | undefined;
  let wcBaseUrl = "";
  const wcCredentials = { key: "ck_96_mock", secret: "cs_96_mock" };

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

    wcServer = createServer((req, res) => {
      const auth = (req.headers.authorization ?? "").replace("Basic ", "");
      const ok =
        auth ===
        Buffer.from(`${wcCredentials.key}:${wcCredentials.secret}`).toString("base64");
      if (!ok) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "no" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    wcServer.listen(0);
    const wcAddress = wcServer.address() as AddressInfo;
    wcBaseUrl = `http://127.0.0.1:${wcAddress.port}`;
  });

  after(async () => {
    server?.close();
    wcServer?.close();
    await pg?.end();
    pg = null;
  });

  let counter = 0;
  const uniqueEmail = () =>
    `ent-${Date.now()}-${(counter += 1)}@example.test`;

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
        fullName: "Ent Test",
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

  /**
   * Dedicated plan with exact features/limits, adopted by the business's
   * open subscription — never the shared free-trial plan.
   */
  async function setBusinessPlan(
    businessId: number,
    plan: {
      price?: number;
      limits?: Record<string, number> | null;
      features?: Record<string, boolean> | null;
    },
  ): Promise<number> {
    counter += 1;
    const slug = `ent-plan-${Date.now()}-${counter}`;
    const created = await pg!.query(
      `INSERT INTO subscription_plans (name, slug, interval, price, currency, limits, features, is_active)
       VALUES ($1, $2, 'monthly', $3, 'BDT', $4::jsonb, $5::jsonb, true) RETURNING id`,
      [
        `Ent plan ${counter}`,
        slug,
        plan.price ?? 500,
        plan.limits ? JSON.stringify(plan.limits) : null,
        plan.features ? JSON.stringify(plan.features) : null,
      ],
    );
    const planId = created.rows[0]!.id as number;
    await pg!.query(
      `UPDATE subscriptions SET plan_id = $1, status = 'active', current_period_end = now() + interval '30 days'
       WHERE business_id = $2 AND status IN ('trialing','active','past_due')`,
      [planId, businessId],
    );
    return planId;
  }

  it("blocks store connection without the woocommerceIntegration feature", async () => {
    const owner = await createOwnerCtx("Ent No Feature Co");
    await api(owner, "PATCH", `/api/businesses/${owner.businessId}/mode`, {
      mode: "omnichannel",
    });
    await setBusinessPlan(owner.businessId, {
      features: { multiLocation: true }, // no integration features
    });

    const res = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/integrations/woocommerce/connect`,
      {
        name: "No feature store",
        storeUrl: wcBaseUrl,
        consumerKey: wcCredentials.key,
        consumerSecret: wcCredentials.secret,
      },
    );
    assert.equal(res.status, 403);
    assert.equal(res.body?.code, "FEATURE_NOT_IN_PLAN");

    // With the feature the connect succeeds.
    await setBusinessPlan(owner.businessId, {
      features: { woocommerceIntegration: true },
    });
    const allowed = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/integrations/woocommerce/connect`,
      {
        name: "Allowed store",
        storeUrl: wcBaseUrl,
        consumerKey: wcCredentials.key,
        consumerSecret: wcCredentials.secret,
      },
    );
    assert.equal(allowed.status, 201);
  });

  it("enforces maxConnectedStores", async () => {
    const owner = await createOwnerCtx("Ent Store Limit Co");
    await api(owner, "PATCH", `/api/businesses/${owner.businessId}/mode`, {
      mode: "omnichannel",
    });
    await setBusinessPlan(owner.businessId, {
      features: { woocommerceIntegration: true, customStorefront: true },
      limits: { maxConnectedStores: 1 },
    });

    const first = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/integrations/woocommerce/connect`,
      {
        name: "Store one",
        storeUrl: wcBaseUrl,
        consumerKey: wcCredentials.key,
        consumerSecret: wcCredentials.secret,
      },
    );
    assert.equal(first.status, 201);

    const second = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/integrations/woocommerce/connect`,
      {
        name: "Store two",
        storeUrl: wcBaseUrl,
        consumerKey: wcCredentials.key,
        consumerSecret: wcCredentials.secret,
      },
    );
    assert.equal(second.status, 403);
    assert.equal(second.body?.code, "PLAN_LIMIT_REACHED");

    // Disconnecting frees the slot.
    const disconnect = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/integrations/${first.body.data.integrationId}/disconnect`,
    );
    assert.equal(disconnect.status, 200);
    const third = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/integrations/woocommerce/connect`,
      {
        name: "Store three",
        storeUrl: wcBaseUrl,
        consumerKey: wcCredentials.key,
        consumerSecret: wcCredentials.secret,
      },
    );
    assert.equal(third.status, 201);
  });

  it("gates API key creation on storefrontApi and webhook endpoints on advancedWebhooks + limits", async () => {
    const owner = await createOwnerCtx("Ent Key Gate Co");
    await api(owner, "PATCH", `/api/businesses/${owner.businessId}/mode`, {
      mode: "omnichannel",
    });

    // No storefrontApi feature → key creation denied.
    await setBusinessPlan(owner.businessId, {
      features: { woocommerceIntegration: true },
    });
    const denied = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefront/keys`,
      { name: "Denied key", scopes: ["products:read"] },
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.body?.code, "FEATURE_NOT_IN_PLAN");

    // Feature present but webhook limit 1: first endpoint OK, second denied.
    await setBusinessPlan(owner.businessId, {
      features: { storefrontApi: true, advancedWebhooks: true },
      limits: { maxWebhookEndpoints: 1 },
    });
    const key = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefront/keys`,
      { name: "Allowed key", scopes: ["products:read"] },
    );
    assert.equal(key.status, 201);

    const hookOne = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/webhooks`,
      { url: "http://127.0.0.1:9/one", events: ["order.created"] },
    );
    assert.equal(hookOne.status, 201);
    const hookTwo = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/webhooks`,
      { url: "http://127.0.0.1:9/two", events: ["order.created"] },
    );
    assert.equal(hookTwo.status, 403);
    assert.equal(hookTwo.body?.code, "PLAN_LIMIT_REACHED");
  });

  it("pauses outbound sync when the entitlement expires (data stays reachable)", async () => {
    const owner = await createOwnerCtx("Ent Expiry Co");
    await api(owner, "PATCH", `/api/businesses/${owner.businessId}/mode`, {
      mode: "omnichannel",
    });
    await setBusinessPlan(owner.businessId, {
      features: { woocommerceIntegration: true },
    });
    const connect = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/integrations/woocommerce/connect`,
      {
        name: "Expiry store",
        storeUrl: wcBaseUrl,
        consumerKey: wcCredentials.key,
        consumerSecret: wcCredentials.secret,
      },
    );
    const integrationId = connect.body.data.integrationId as number;

    // Entitlement removed → pushProducts skips (returns 0) and logs.
    await setBusinessPlan(owner.businessId, { features: {} });
    const pushed = await pushProducts(integrationId);
    assert.equal(pushed, 0);
    const logs = await pg!.query(
      "SELECT message FROM integration_sync_logs WHERE integration_id = $1 AND job_type = 'entitlement' ORDER BY id DESC LIMIT 1",
      [integrationId],
    );
    assert.match(logs.rows[0]!.message as string, /sync paused/);

    // Historical data (logs) and the connection record remain reachable
    // through the portal — no lockout.
    const list = await api(
      owner,
      "GET",
      `/api/businesses/${owner.businessId}/integrations`,
    );
    assert.equal(list.status, 200);
    assert.ok(list.body.data.length >= 1);
  });
});
