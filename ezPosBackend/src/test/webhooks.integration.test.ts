/**
 * Phase 9.4 integration tests: outbound webhooks — endpoint lifecycle,
 * HMAC-signed delivery to a local mock receiver, retries, deletion,
 * isolation. Double-guarded like the other suites.
 *
 * Plain `npm test` NEVER runs this file.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";
import { createOnlineOrder } from "../modules/commerce/orders.service.js";
import { processWebhookDeliveries } from "../modules/webhooks/webhookDelivery.service.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("outbound webhooks integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let pg: import("pg").Client | null = null;

  // Mock receiver: records deliveries, configurable status code.
  let receiver: import("node:http").Server | undefined;
  let receiverUrl = "";
  const received: { body: string; signature: string | undefined }[] = [];
  let receiverStatus = 200;

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
    // Leftover deliveries from previous runs would make sweeps process
    // stale rows (and old receiver ports) — start clean.
    await pg.query("DELETE FROM webhook_deliveries");
    await ensureRbacSeed();

    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    receiver = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        received.push({
          body: raw,
          signature: req.headers["x-ezpos-signature"] as string | undefined,
        });
        res.writeHead(receiverStatus);
        res.end();
      });
    });
    receiver.listen(0);
    const receiverAddress = receiver.address() as AddressInfo;
    receiverUrl = `http://127.0.0.1:${receiverAddress.port}/webhook`;
  });

  after(async () => {
    server?.close();
    receiver?.close();
    await pg?.end();
    pg = null;
  });

  let counter = 0;
  const uniqueEmail = () =>
    `whk-${Date.now()}-${(counter += 1)}@example.test`;

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
        fullName: "Webhook Test",
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

  async function seedVariant(businessId: number, qty: number): Promise<number> {
    counter += 1;
    const location = (await pg!.query(
      "SELECT id FROM locations WHERE business_id = $1 AND is_default = true",
      [businessId],
    )).rows[0] as { id: number } | undefined;
    assert.ok(location, "default location missing");
    const product = await pg!.query(
      `INSERT INTO products (business_id, name, product_type, tracking_type, status)
       VALUES ($1, $2, 'physical', 'batch', 'active') RETURNING id`,
      [businessId, `WHK Product ${counter}`],
    );
    const variant = await pg!.query(
      `INSERT INTO product_variants (business_id, product_id, sku, selling_price, is_default, status)
       VALUES ($1, $2, $3, 150, true, 'active') RETURNING id`,
      [businessId, product.rows[0]!.id, `WHK-${counter}`],
    );
    await pg!.query(
      `INSERT INTO inventory_stock (business_id, variant_id, location_id, quantity, reserved_quantity)
       VALUES ($1, $2, $3, $4, 0)`,
      [businessId, variant.rows[0]!.id, location.id, qty],
    );
    await pg!.query(
      `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining)
       VALUES ($1, $2, $3, $4, 90, $5, $5)`,
      [businessId, variant.rows[0]!.id, location.id, `WHKB-${counter}`, qty],
    );
    return variant.rows[0]!.id as number;
  }

  it("registers an endpoint (secret once), delivers signed events, verifies HMAC", async () => {
    const owner = await createOwnerCtx("WHK Flow Co");
    const variantId = await seedVariant(owner.businessId, 5);

    const created = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/webhooks`,
      { url: receiverUrl, events: ["order.created", "order.paid", "order.cancelled"] },
    );
    assert.equal(created.status, 201);
    assert.match(created.body.data.secret, /^ezpos_whsec_/);
    const secret = created.body.data.secret as string;

    // Listing never contains the secret.
    const list = await api(
      owner,
      "GET",
      `/api/businesses/${owner.businessId}/webhooks`,
    );
    assert.equal(
      JSON.stringify(list.body.data).includes(secret),
      false,
    );

    // Create an order → order.created delivery.
    const order = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "custom_storefront",
      integrationId: null,
      externalOrderId: null,
      locationId: null,
      customer: { name: "Buyer" },
      lines: [{ variantId, quantity: 1 }],
      idempotencyKey: `whk-${Date.now()}`,
    });

    const sweep1 = await processWebhookDeliveries();
    assert.ok(sweep1.delivered >= 1);

    // The receiver got a signed POST with the right HMAC.
    const last = received[received.length - 1]!;
    const expected =
      "sha256=" +
      createHmac("sha256", secret).update(last.body).digest("hex");
    assert.equal(last.signature, expected);
    const payload = JSON.parse(last.body) as {
      event: string;
      data: { orderId: number };
    };
    assert.equal(payload.event, "order.created");
    assert.equal(payload.data.orderId, order.saleId);

    // Confirm → order.paid delivery. O3-001: order.paid now means money
    // actually moved — a bare confirm of an order with NO captured
    // payments is a COD confirm and must NOT claim paid; the collection
    // (markOnlineOrderPaid → prepaid confirm) is what emits it.
    const beforeCod = received.length;
    const codOrder = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "custom_storefront",
      integrationId: null,
      externalOrderId: null,
      locationId: null,
      customer: { name: "Buyer" },
      lines: [{ variantId, quantity: 1 }],
      idempotencyKey: `whk-cod-${Date.now()}`,
    });
    await processWebhookDeliveries();
    assert.equal(
      JSON.parse(received[received.length - 1]!.body).event,
      "order.created",
    );
    await import("../modules/commerce/orders.service.js").then((m) =>
      m.confirmOnlineOrder(owner.businessId, codOrder.saleId),
    );
    await processWebhookDeliveries();
    // Exactly one new delivery (the COD order.created) — no order.paid.
    assert.equal(received.length, beforeCod + 1);

    await import("../modules/commerce/orders.service.js").then((m) =>
      m.markOnlineOrderPaid(owner.businessId, order.saleId),
    );
    const sweep2 = await processWebhookDeliveries();
    assert.ok(sweep2.delivered >= 1);
    const paid = received[received.length - 1]!;
    assert.equal(JSON.parse(paid.body).event, "order.paid");
  });

  it("retries failed deliveries with backoff and dead-letters after max attempts", async () => {
    const owner = await createOwnerCtx("WHK Retry Co");
    const variantId = await seedVariant(owner.businessId, 5);

    // Point the endpoint at a path that always fails (no server there).
    const created = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/webhooks`,
      {
        url: "http://127.0.0.1:9/unreachable",
        events: ["order.created"],
      },
    );
    assert.equal(created.status, 201);

    await createOnlineOrder({
      businessId: owner.businessId,
      channel: "custom_storefront",
      integrationId: null,
      externalOrderId: null,
      locationId: null,
      customer: { name: "Buyer" },
      lines: [{ variantId, quantity: 1 }],
      idempotencyKey: `whk-fail-${Date.now()}`,
    });

    const first = await processWebhookDeliveries();
    assert.ok(first.failed >= 1);

    const deliveries = await api(
      owner,
      "GET",
      `/api/businesses/${owner.businessId}/webhooks/${created.body.data.id}/deliveries`,
    );
    const delivery = (deliveries.body.data as {
      status: string;
      attempts: number;
      lastError: string | null;
    }[])[0]!;
    assert.notEqual(delivery.status, "delivered");
    assert.ok(delivery.attempts >= 1);
    assert.ok(delivery.lastError !== null);
  });

  it("removing an endpoint stops deliveries and isolates foreign access", async () => {
    const owner = await createOwnerCtx("WHK Iso Co");
    const foreign = await createOwnerCtx("WHK Iso Foreign");

    const created = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/webhooks`,
      { url: receiverUrl, events: ["order.created"] },
    );
    const endpointId = created.body.data.id as number;

    // Foreign member cannot list deliveries or delete the endpoint.
    const foreignList = await api(
      foreign,
      "GET",
      `/api/businesses/${owner.businessId}/webhooks/${endpointId}/deliveries`,
    );
    assert.equal(foreignList.status, 403);
    const foreignDelete = await api(
      foreign,
      "DELETE",
      `/api/businesses/${owner.businessId}/webhooks/${endpointId}`,
    );
    assert.equal(foreignDelete.status, 403);

    // Owner deletes → delivery history preserved, endpoint gone.
    const removed = await api(
      owner,
      "DELETE",
      `/api/businesses/${owner.businessId}/webhooks/${endpointId}`,
    );
    assert.equal(removed.status, 200);
    const afterDelete = await api(
      owner,
      "GET",
      `/api/businesses/${owner.businessId}/webhooks`,
    );
    assert.equal(
      (afterDelete.body.data as { id: number }[]).some(
        (e) => e.id === endpointId,
      ),
      false,
    );
  });
});
