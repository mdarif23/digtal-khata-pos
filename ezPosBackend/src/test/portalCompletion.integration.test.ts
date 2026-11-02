/**
 * Portal completion integration tests (logo, export, notifications,
 * sessions, saas-admin business detail). Double-guarded like the other
 * suites.
 *
 * Plain `npm test` NEVER runs this file.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { createOnlineOrder } from "../modules/commerce/orders.service.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("portal completion integration", { skip: !runIntegration }, () => {
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
    `pc-${Date.now()}-${(counter += 1)}@example.test`;

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
        fullName: "PC Test",
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

  const LOGO =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("sets a logo via update (persisted + returned) and rejects bad data URLs", async () => {
    const owner = await createOwnerCtx("PC Logo Co");

    const bad = await api(owner, "PUT", `/api/businesses/${owner.businessId}`, {
      logoDataUrl: "data:text/html;base64,PGI+aGk8L2I+",
    });
    assert.equal(bad.status, 400);

    const set = await api(owner, "PUT", `/api/businesses/${owner.businessId}`, {
      logoDataUrl: LOGO,
    });
    assert.equal(set.status, 200);

    const detail = await api(owner, "GET", `/api/businesses/${owner.businessId}`);
    assert.equal(detail.body.business.logoUrl, LOGO);
  });

  it("exports business data as a scoped JSON download", async () => {
    const ownerA = await createOwnerCtx("PC Export A");
    await seedVariant(ownerA.businessId, 3, "Export product");

    const res = await fetch(
      `${baseUrl}/api/businesses/${ownerA.businessId}/export`,
      { headers: { Authorization: `Bearer ${ownerA.token}` } },
    );
    assert.equal(res.status, 200);
    assert.match(
      res.headers.get("content-disposition") ?? "",
      /attachment; filename=/,
    );
    const data = (await res.json()) as {
      format: string;
      business: { name: string };
      products: { name: string }[];
    };
    assert.equal(data.format, "ezpos-export-v1");
    assert.equal(data.business.name, "PC Export A");
    assert.equal(data.products.length, 1);
    assert.equal(data.products[0]!.name, "Export product");
  });

  it("notifies on online order confirmation and supports read-all", async () => {
    const owner = await createOwnerCtx("PC Notif Co");
    const variantId = await seedVariant(owner.businessId, 5, "Notif product");

    // Simulate an online sale via SQL: channel woocommerce + completed.
    const sale = await pg!.query(
      `INSERT INTO sales (business_id, status, channel, subtotal, discount, vat, final_total, payment_status, due_amount)
       VALUES ($1, 'completed', 'woocommerce', 100, 0, 0, 100, 'paid', 0) RETURNING id`,
      [owner.businessId],
    );
    // Emit through the exported service for accuracy.

    const order = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "custom_storefront",
      integrationId: null,
      externalOrderId: null,
      locationId: null,
      customer: { name: "Notif Buyer" },
      lines: [{ variantId, quantity: 1 }],
      idempotencyKey: `pc-${Date.now()}`,
    });
    void sale;

    const list = await api(
      owner,
      "GET",
      `/api/businesses/${owner.businessId}/notifications`,
    );
    assert.equal(list.status, 200);
    assert.ok(list.body.data.unreadCount >= 1);
    const created = (list.body.data.notifications as {
      id: number;
      type: string;
    }[]).find((n) => n.type === "order.created");
    assert.ok(created, "order.created notification missing");

    const readAll = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/notifications/read-all`,
    );
    assert.equal(readAll.status, 200);
    const after = await api(
      owner,
      "GET",
      `/api/businesses/${owner.businessId}/notifications`,
    );
    assert.equal(after.body.data.unreadCount, 0);
    void order;
  });

  it("lists active sessions and revokes a specific one", async () => {
    const owner = await createOwnerCtx("PC Sessions Co");

    const list = await api(owner, "GET", "/api/auth/sessions");
    assert.equal(list.status, 200);
    assert.ok(list.body.data.length >= 1);
    const sessionId = list.body.data[0].id as number;

    // Foreign user cannot revoke someone else's session.
    const other = await createOwnerCtx("PC Sessions Other");
    const foreign = await api(other, "DELETE", `/api/auth/sessions/${sessionId}`);
    assert.equal(foreign.status, 404);

    const revoke = await api(owner, "DELETE", `/api/auth/sessions/${sessionId}`);
    assert.equal(revoke.status, 200);
    const after = await api(owner, "GET", "/api/auth/sessions");
    assert.equal(
      (after.body.data as { id: number }[]).some((s) => s.id === sessionId),
      false,
    );
  });

  it("saas-admin business detail is admin-only and complete", async () => {
    const owner = await createOwnerCtx("PC Detail Co");
    const admin = await createOwnerCtx("PC Detail Admin");
    await pg!.query(
      "UPDATE users SET platform_role = 'platform_admin' WHERE id = $1",
      [admin.userId],
    );

    const denied = await api(
      owner,
      "GET",
      `/api/saas/businesses/${owner.businessId}/detail`,
    );
    assert.equal(denied.status, 403);

    const detail = await api(
      admin,
      "GET",
      `/api/saas/businesses/${owner.businessId}/detail`,
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.name, "PC Detail Co");
    assert.ok(Array.isArray(detail.body.data.users));
    assert.ok(detail.body.data.users.some((u: { userId: number }) => u.userId === owner.userId));
    assert.ok(Array.isArray(detail.body.data.locations));
    assert.ok(Array.isArray(detail.body.data.invoices));

    // Foreign business → 404 (admin sees all, but a nonexistent id 404s).
    const missing = await api(
      admin,
      "GET",
      "/api/saas/businesses/99999999/detail",
    );
    assert.equal(missing.status, 404);
  });

  async function seedVariant(businessId: number, qty: number, name: string): Promise<number> {
    counter += 1;
    const location = (await pg!.query(
      "SELECT id FROM locations WHERE business_id = $1 AND is_default = true",
      [businessId],
    )).rows[0] as { id: number } | undefined;
    assert.ok(location, "default location missing");
    const product = await pg!.query(
      `INSERT INTO products (business_id, name, product_type, tracking_type, status)
       VALUES ($1, $2, 'physical', 'batch', 'active') RETURNING id`,
      [businessId, name],
    );
    const variant = await pg!.query(
      `INSERT INTO product_variants (business_id, product_id, sku, selling_price, is_default, status)
       VALUES ($1, $2, $3, 100, true, 'active') RETURNING id`,
      [businessId, product.rows[0]!.id, `PC-${counter}`],
    );
    await pg!.query(
      `INSERT INTO inventory_stock (business_id, variant_id, location_id, quantity, reserved_quantity)
       VALUES ($1, $2, $3, $4, 0)`,
      [businessId, variant.rows[0]!.id, location.id, qty],
    );
    await pg!.query(
      `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining)
       VALUES ($1, $2, $3, $4, 50, $5, $5)`,
      [businessId, variant.rows[0]!.id, location.id, `PCB-${counter}`, qty],
    );
    return variant.rows[0]!.id as number;
  }

    it("registers with termsAccepted and stamps the business on creation", async () => {
      const email = uniqueEmail();
      const reg = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: "Terms Test",
          email,
          password: "strong-password-123",
          termsAccepted: true,
        }),
      });
      assert.equal(reg.status, 201);
      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "strong-password-123" }),
      });
      const loginBody = (await login.json()) as { accessToken: string };
      const biz = await fetch(`${baseUrl}/api/businesses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${loginBody.accessToken}`,
        },
        body: JSON.stringify({ name: "Terms Co", termsAccepted: true }),
      });
      assert.equal(biz.status, 201);
      const stamped = (await pg!.query(
        "SELECT terms_accepted_at FROM businesses WHERE id = $1",
        [(await biz.json()).business.id],
      )).rows[0] as { terms_accepted_at: string };
      assert.ok(stamped.terms_accepted_at !== null);
    });

    it("onboardingStep persists through updateBusiness", async () => {
      const email = uniqueEmail();
      const reg = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: "Onb Test",
          email,
          password: "strong-password-123",
        }),
      });
      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "strong-password-123" }),
      });
      const { accessToken } = (await login.json()) as { accessToken: string };
      const biz = await fetch(`${baseUrl}/api/businesses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ name: "Onb Co" }),
      });
      const { id } = (await biz.json()).business as { id: number };

      const put = await fetch(`${baseUrl}/api/businesses/${id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "X-Business-Id": String(id),
        },
        body: JSON.stringify({ onboardingStep: 2 }),
      });
      assert.equal(put.status, 200);
      const detail = (await (
        await fetch(`${baseUrl}/api/businesses/${id}`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "X-Business-Id": String(id),
          },
        })
      ).json()) as { business: { onboardingStep: number } };
      assert.equal(detail.business.onboardingStep, 2);
    });

    it("sessions expose lastUsedAt after a refresh", async () => {
      const email = uniqueEmail();
      await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: "Sess Test",
          email,
          password: "strong-password-123",
        }),
      });
      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "strong-password-123" }),
      });
      const { accessToken } = (await login.json()) as { accessToken: string };
      // A refresh stamps last_used_at on the rotating token. Capture the
      // refresh cookie from login and send it (node fetch has no cookie jar).
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "strong-password-123" }),
      });
      const setCookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0]!;
      await fetch(`${baseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { Cookie: setCookie },
      });

      const list = await fetch(`${baseUrl}/api/auth/sessions`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const sessions = (await list.json()).data as {
        lastUsedAt: string | null;
      }[];
      assert.ok(sessions.some((s) => s.lastUsedAt !== null));
    });

    it("support tickets accept category and priority", async () => {
      const email = uniqueEmail();
      const reg = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: "Cat Test",
          email,
          password: "strong-password-123",
        }),
      });
      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "strong-password-123" }),
      });
      const { accessToken } = (await login.json()) as { accessToken: string };

      const create = await fetch(`${baseUrl}/api/support/tickets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          subject: "Category test",
          message: "Testing the category and priority fields on tickets.",
          category: "billing",
          priority: "high",
        }),
      });
      assert.equal(create.status, 201);
      const row = (await pg!.query(
        "SELECT category, priority FROM support_tickets WHERE subject = 'Category test' ORDER BY id DESC LIMIT 1",
      )).rows[0] as { category: string; priority: string };
      assert.equal(row.category, "billing");
      assert.equal(row.priority, "high");
    });

});

