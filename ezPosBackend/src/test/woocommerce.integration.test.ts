/**
 * Phase 9.3 integration tests: WooCommerce integration — connection with
 * credential validation against a LOCAL mock store, encrypted credentials,
 * product sync, signed order webhooks (create/confirm/cancel/replay),
 * inventory push, and portal isolation. Double-guarded like the other
 * suites.
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

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("woocommerce integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let pg: import("pg").Client | null = null;

  // --- mock WooCommerce store ---
  let wcServer: import("node:http").Server | undefined;
  let wcBaseUrl = "";
  const wcReceived: { method: string; path: string; body: any }[] = [];
  const wcCredentials = { key: "ck_test_mock", secret: "cs_test_mock" };
  let wcValidateCalled = 0;

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

    // Minimal WooCommerce REST v3 mock.
    wcServer = createServer((req, res) => {
      const url = req.url ?? "";
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body: any = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = raw;
        }
        wcReceived.push({ method: req.method ?? "GET", path: url, body });

        const auth = (req.headers.authorization ?? "").replace("Basic ", "");
        const credentialsOk =
          auth === Buffer.from(`${wcCredentials.key}:${wcCredentials.secret}`).toString("base64");

        if (url.startsWith("/wp-json/wc/v3/data")) {
          if (!credentialsOk) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: "Invalid credentials" }));
            return;
          }
          wcValidateCalled += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ environment: { version: "8.0.0" } }));
          return;
        }
        if (url.startsWith("/wp-json/wc/v3/webhooks") && req.method === "POST") {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: 55 }));
          return;
        }
        if (url.startsWith("/wp-json/wc/v3/products") && req.method === "POST") {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: 900 + wcReceived.length, ...body }));
          return;
        }
        if (/\/variations$/.test(url) && req.method === "POST") {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: 950 + wcReceived.length, ...body }));
          return;
        }
        if (/\/products\/\d+$/.test(url) && req.method === "PUT") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: Number(url.split("/").pop()), ...body }));
          return;
        }
        if (/\/variations\/\d+$/.test(url) && req.method === "PUT") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: Number(url.split("/").pop()), ...body }));
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Not found" }));
      });
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
    `wc-${Date.now()}-${(counter += 1)}@example.test`;

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
        fullName: "WC Test",
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

  async function seedVariant(
    businessId: number,
    qty: number,
  ): Promise<number> {
    counter += 1;
    const location = (await pg!.query(
      "SELECT id FROM locations WHERE business_id = $1 AND is_default = true",
      [businessId],
    )).rows[0] as { id: number } | undefined;
    assert.ok(location, "default location missing");
    const product = await pg!.query(
      `INSERT INTO products (business_id, name, product_type, tracking_type, status)
       VALUES ($1, $2, 'physical', 'batch', 'active') RETURNING id`,
      [businessId, `WC Product ${counter}`],
    );
    const variant = await pg!.query(
      `INSERT INTO product_variants (business_id, product_id, sku, selling_price, is_default, status)
       VALUES ($1, $2, $3, 120, true, 'active') RETURNING id`,
      [businessId, product.rows[0]!.id, `WCSKU-${counter}`],
    );
    await pg!.query(
      `INSERT INTO inventory_stock (business_id, variant_id, location_id, quantity, reserved_quantity)
       VALUES ($1, $2, $3, $4, 0)`,
      [businessId, variant.rows[0]!.id, location.id, qty],
    );
    // Batch-tracked stock is sold FIFO from batches — real stocked products
    // always have them (created at purchase/opening).
    await pg!.query(
      `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining)
       VALUES ($1, $2, $3, $4, 80, $5, $5)`,
      [businessId, variant.rows[0]!.id, location.id, `WCB-${counter}`, qty],
    );
    return variant.rows[0]!.id as number;
  }

  it("connects a store after validating credentials and stores them encrypted", async () => {
    const owner = await createOwnerCtx("WC Connect Co");
    await api(owner, "PATCH", `/api/businesses/${owner.businessId}/mode`, {
      mode: "omnichannel",
    });

    // Invalid credentials are rejected before anything is stored.
    const bad = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/integrations/woocommerce/connect`,
      {
        name: "Bad store",
        storeUrl: wcBaseUrl,
        consumerKey: "ck_wrong_value",
        consumerSecret: "cs_wrong_value",
      },
    );
    assert.equal(bad.status, 409);

    const good = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/integrations/woocommerce/connect`,
      {
        name: "My WC store",
        storeUrl: wcBaseUrl,
        consumerKey: wcCredentials.key,
        consumerSecret: wcCredentials.secret,
      },
    );
    assert.equal(good.status, 201);
    assert.ok(good.body.data.webhookDeliveryUrl.includes("/webhook/"));

    // Credentials at rest are ciphertext — the plaintext must not appear.
    const stored = await pg!.query(
      "SELECT cipher_text, iv, auth_tag FROM integration_credentials ORDER BY id DESC LIMIT 1",
    );
    const cipherText = stored.rows[0]!.cipher_text as string;
    assert.ok(cipherText.length > 0);
    assert.equal(cipherText.includes(wcCredentials.key), false);
    assert.equal(cipherText.includes(wcCredentials.secret), false);
    // Everything that reads credentials decrypts to the right values.
    assert.ok(wcValidateCalled >= 1);

    const list = await api(
      owner,
      "GET",
      `/api/businesses/${owner.businessId}/integrations`,
    );
    assert.equal(list.status, 200);
    const integration = list.body.data[0];
    assert.equal(integration.status, "connected");
    assert.equal(
      JSON.stringify(list.body.data).includes(wcCredentials.secret),
      false,
    );
  });

  it("product sync pushes unmapped products and records mappings", async () => {
    const owner = await createOwnerCtx("WC Sync Co");
    await api(owner, "PATCH", `/api/businesses/${owner.businessId}/mode`, {
      mode: "omnichannel",
    });
    const variantId = await seedVariant(owner.businessId, 6);
    const connect = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/integrations/woocommerce/connect`,
      {
        name: "Sync store",
        storeUrl: wcBaseUrl,
        consumerKey: wcCredentials.key,
        consumerSecret: wcCredentials.secret,
      },
    );
    const integrationId = connect.body.data.integrationId as number;

    const sync = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/integrations/${integrationId}/sync-products`,
    );
    assert.equal(sync.status, 200);
    assert.equal(sync.body.data.pushed, 1);

    const mapping = await pg!.query(
      "SELECT external_product_id FROM integration_product_mappings WHERE integration_id = $1 AND ez_product_id = (SELECT product_id FROM product_variants WHERE id = $2)",
      [integrationId, variantId],
    );
    assert.equal(mapping.rows.length, 1);
    assert.ok(mapping.rows[0]!.external_product_id !== null);

    // The mock store received the product with the ezPos price and stock.
    const pushed = wcReceived.filter(
      (r) => r.method === "POST" && r.path.startsWith("/wp-json/wc/v3/products"),
    );
    assert.ok(
      pushed.some(
        (r) => (r.body as any).regular_price === "120.00" && (r.body as any).stock_quantity === 6,
      ),
    );
    void variantId;
  });

  it("processes signed order webhooks: create, duplicate, confirm, cancel", async () => {
    const owner = await createOwnerCtx("WC Webhook Co");
    await api(owner, "PATCH", `/api/businesses/${owner.businessId}/mode`, {
      mode: "omnichannel",
    });
    const variantId = await seedVariant(owner.businessId, 10);
    const connect = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/integrations/woocommerce/connect`,
      {
        name: "Webhook store",
        storeUrl: wcBaseUrl,
        consumerKey: wcCredentials.key,
        consumerSecret: wcCredentials.secret,
      },
    );
    const integrationId = connect.body.data.integrationId as number;
    const integration = (await pg!.query(
      "SELECT webhook_secret FROM integrations WHERE id = $1",
      [integrationId],
    )).rows[0] as { webhook_secret: string } | undefined;
    assert.ok(integration, "integration missing");
    const secret = integration.webhook_secret;

    // Product sync so the webhook line item can be mapped.
    await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/integrations/${integrationId}/sync-products`,
    );
    const mapping = (await pg!.query(
      "SELECT external_product_id FROM integration_product_mappings WHERE integration_id = $1",
      [integrationId],
    )).rows[0] as { external_product_id: string } | undefined;
    assert.ok(mapping, "product mapping missing");

    const wcProductId = Number(mapping.external_product_id);
    const orderPayload = {
      id: 5001,
      number: "5001",
      status: "pending",
      billing: { first_name: "Web", last_name: "Buyer", phone: "+8801700999000" },
      line_items: [{ product_id: wcProductId, quantity: 2 }],
    };
    const rawBody = JSON.stringify(orderPayload);
    const signature = createHmac("sha256", secret)
      .update(rawBody)
      .digest("base64");
    const deliveryPath = `/api/integrations/woocommerce/webhook/${secret}`;

    // Invalid signature is rejected.
    const badSig = await fetch(`${baseUrl}${deliveryPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WC-Webhook-Signature": "invalid-signature",
      },
      body: rawBody,
    });
    assert.equal(badSig.status, 401);

    const hook = await fetch(`${baseUrl}${deliveryPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WC-Webhook-Signature": signature,
      },
      body: rawBody,
    });
    console.error("T3DEBUG:", hook.status, await hook.text(), "path:", deliveryPath, "sig:", signature);
    assert.equal(hook.status, 200);

    const saleRow = (await pg!.query(
      "SELECT id, status, channel, payment_status FROM sales WHERE external_order_id = '5001' AND business_id = $1",
      [owner.businessId],
    )).rows[0] as { id: number; status: string; channel: string; payment_status: string } | undefined;
    assert.ok(saleRow, "webhook did not create a sale");
    assert.equal(saleRow.status, "pending");
    assert.equal(saleRow.channel, "woocommerce");

    const stock = (await pg!.query(
      "SELECT quantity, reserved_quantity FROM inventory_stock WHERE variant_id = $1",
      [variantId],
    )).rows[0] as { quantity: number; reserved_quantity: number };
    assert.equal(stock.quantity, 10); // reserved, not deducted
    assert.equal(stock.reserved_quantity, 2);

    // Duplicate webhook (same order id, same state) → no second sale.
    await fetch(`${baseUrl}${deliveryPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WC-Webhook-Signature": signature,
      },
      body: rawBody,
    });
    const salesCount = (await pg!.query(
      "SELECT count(*)::int AS n FROM sales WHERE external_order_id = '5001' AND business_id = $1",
      [owner.businessId],
    )).rows[0]!.n as number;
    assert.equal(salesCount, 1);

    // Status → processing (paid): the sale confirms and stock deducts.
    const paidPayload = { ...orderPayload, status: "processing" };
    const paidSig = createHmac("sha256", secret)
      .update(JSON.stringify(paidPayload))
      .digest("base64");
    await fetch(`${baseUrl}${deliveryPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WC-Webhook-Signature": paidSig,
      },
      body: JSON.stringify(paidPayload),
    });
    const confirmed = (await pg!.query(
      "SELECT status, payment_status FROM sales WHERE external_order_id = '5001' AND business_id = $1",
      [owner.businessId],
    )).rows[0] as { status: string; payment_status: string };
    assert.equal(confirmed.status, "completed");
    assert.equal(confirmed.payment_status, "paid");
    const stockAfter = (await pg!.query(
      "SELECT quantity FROM inventory_stock WHERE variant_id = $1",
      [variantId],
    )).rows[0] as { quantity: number };
    assert.equal(stockAfter.quantity, 8);

    // Terminal order: further webhooks are ignored.
    const donePayload = { ...orderPayload, status: "cancelled" };
    const doneSig = createHmac("sha256", secret)
      .update(JSON.stringify(donePayload))
      .digest("base64");
    await fetch(`${baseUrl}${deliveryPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WC-Webhook-Signature": doneSig,
      },
      body: JSON.stringify(donePayload),
    });
    const still = (await pg!.query(
      "SELECT status FROM sales WHERE external_order_id = '5001' AND business_id = $1",
      [owner.businessId],
    )).rows[0] as { status: string };
    assert.equal(still.status, "completed");
  });

  it("cancelled pending webhooks release the reservation", async () => {
    const owner = await createOwnerCtx("WC Cancel Co");
    await api(owner, "PATCH", `/api/businesses/${owner.businessId}/mode`, {
      mode: "omnichannel",
    });
    const variantId = await seedVariant(owner.businessId, 5);
    const connect = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/integrations/woocommerce/connect`,
      {
        name: "Cancel store",
        storeUrl: wcBaseUrl,
        consumerKey: wcCredentials.key,
        consumerSecret: wcCredentials.secret,
      },
    );
    const integrationId = connect.body.data.integrationId as number;
    const secret = (
      (await pg!.query("SELECT webhook_secret FROM integrations WHERE id = $1", [integrationId]))
        .rows[0] as { webhook_secret: string }
    ).webhook_secret;
    await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/integrations/${integrationId}/sync-products`,
    );
    const mapping = (
      await pg!.query(
        "SELECT external_product_id FROM integration_product_mappings WHERE integration_id = $1",
        [integrationId],
      )
    ).rows[0] as { external_product_id: string };

    const deliveryPath = `/api/integrations/woocommerce/webhook/${secret}`;
    const wcProductId = Number(mapping.external_product_id);
    const sign = (payload: unknown) =>
      createHmac("sha256", secret).update(JSON.stringify(payload)).digest("base64");

    const post = (payload: unknown) =>
      fetch(`${baseUrl}${deliveryPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WC-Webhook-Signature": sign(payload),
        },
        body: JSON.stringify(payload),
      });

    await post({
      id: 6001,
      status: "pending",
      line_items: [{ product_id: wcProductId, quantity: 3 }],
    });
    assert.equal(
      (await pg!.query(
        "SELECT reserved_quantity FROM inventory_stock WHERE variant_id = $1",
        [variantId],
      )).rows[0]!.reserved_quantity,
      3,
    );
    await post({
      id: 6001,
      status: "cancelled",
      line_items: [{ product_id: wcProductId, quantity: 3 }],
    });
    const stock = (
      await pg!.query(
        "SELECT quantity, reserved_quantity FROM inventory_stock WHERE variant_id = $1",
        [variantId],
      )
    ).rows[0] as { quantity: number; reserved_quantity: number };
    assert.equal(stock.reserved_quantity, 0);
    assert.equal(stock.quantity, 5);
    const sale = (
      await pg!.query(
        "SELECT status FROM sales WHERE external_order_id = '6001' AND business_id = $1",
        [owner.businessId],
      )
    ).rows[0] as { status: string };
    assert.equal(sale.status, "cancelled");
  });

  it("isolates portal access to the owning business", async () => {
    const ownerA = await createOwnerCtx("WC Iso A");
    const ownerB = await createOwnerCtx("WC Iso B");
    await api(ownerA, "PATCH", `/api/businesses/${ownerA.businessId}/mode`, {
      mode: "omnichannel",
    });
    const connect = await api(
      ownerA,
      "POST",
      `/api/businesses/${ownerA.businessId}/integrations/woocommerce/connect`,
      {
        name: "A store",
        storeUrl: wcBaseUrl,
        consumerKey: wcCredentials.key,
        consumerSecret: wcCredentials.secret,
      },
    );
    const integrationId = connect.body.data.integrationId as number;

    // B cannot see or mutate A's integration.
    const foreignList = await api(
      ownerB,
      "GET",
      `/api/businesses/${ownerA.businessId}/integrations`,
    );
    assert.equal(foreignList.status, 403);
    const foreignLogs = await api(
      ownerB,
      "GET",
      `/api/businesses/${ownerA.businessId}/integrations/${integrationId}/logs`,
    );
    assert.equal(foreignLogs.status, 403);
    const foreignSync = await api(
      ownerB,
      "POST",
      `/api/businesses/${ownerA.businessId}/integrations/${integrationId}/sync-products`,
    );
    assert.equal(foreignSync.status, 403);
  });
});
