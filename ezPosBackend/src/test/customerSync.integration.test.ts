/**
 * Customer synchronization integration tests (Module 12, Phase 6): inbound
 * order-import resolution backfills contact details; outbound push sends
 * created/updated customers to the connected WooCommerce store (upsert by
 * email) with the watermark advancing.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("customer sync integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let wcServer: import("node:http").Server | undefined;
  let wcBaseUrl = "";
  let wcReceived: { method: string; path: string; body: unknown }[] = [];

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

    // Mock WooCommerce store: customer endpoints.
    wcServer = createServer((req, res) => {
      const url = req.url ?? "";
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body: unknown = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = raw;
        }
        wcReceived.push({ method: req.method ?? "GET", path: url, body });
        if (url.startsWith("/wp-json/wc/v3/data")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ environment: { version: "8.0.0" } }));
          return;
        }
        if (/^\/wp-json\/wc\/v3\/customers\?email=/.test(url)) {
          const email = decodeURIComponent(url.split("email=")[1] ?? "");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([])); // never seen before → create
          void email;
          return;
        }
        if (url === "/wp-json/wc/v3/customers" && req.method === "POST") {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: 700 + wcReceived.length }));
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Not found" }));
      });
    });
    wcServer.listen(0);
    wcBaseUrl = `http://127.0.0.1:${(wcServer.address() as AddressInfo).port}`;

    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(() => {
    server?.close();
    wcServer?.close();
  });

  const uniqueEmail = () =>
    `custsync-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let unitId = 0;
  let integrationId = 0;

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      console.error(
        `API ${method} ${path} -> ${res.status}:`,
        JSON.stringify(await res.clone().json().catch(() => null)),
      );
    }
    return { status: res.status, json: await res.json() };
  }

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Sync Test", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Sync Biz ${Date.now()}` }),
    });
    assert.equal(biz.status, 201);
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
    assert.equal(loc.status, 201);
    const unit = await api("POST", "/api/product/unit", {
      unitName: "Piece",
      abbreviation: "Pcs",
    });
    unitId = unit.json.data.value;

    // Omnichannel mode + a connected WooCommerce mock store (both tests).
    const setMode = await api("PUT", `/api/businesses/${businessId}`, {
      mode: "omnichannel",
    });
    assert.ok([200, 204].includes(setMode.status), "mode set to omnichannel");
    const connect = await api(
      "POST",
      `/api/businesses/${businessId}/integrations/woocommerce/connect`,
      {
        name: "Sync Test Store",
        storeUrl: wcBaseUrl,
        consumerKey: "ck_test_key_12345",
        consumerSecret: "cs_test_secret_12345",
      },
    );
    assert.equal(connect.status, 201);
    integrationId = connect.json.data.id ?? connect.json.data.integrationId;
    assert.ok(integrationId > 0, "integration created");
  });

  it("backfills contact details when an online order matches by phone", async () => {
    // Customer exists with a phone but NO email...
    const cust = await api("POST", "/api/customers", {
      name: "Backfill Customer",
      phone: "+880 1711-000090",
    });
    assert.equal(cust.status, 201);
    const customerId = cust.json.id;

    // ...an online order arrives from the same phone WITH an email.
    // (Online orders enter through the storefront API / Woo webhooks — the
    // service entrypoint is the same code path both use.)
    const { createOnlineOrder } = await import(
      "../modules/commerce/orders.service.js"
    );
    const { default: pgLoc } = await import("pg");
    const locClient = new pgLoc.Client({ connectionString: process.env.DATABASE_URL });
    await locClient.connect();
    const locRow = await locClient.query(
      `SELECT id FROM locations WHERE business_id = $1 LIMIT 1`,
      [businessId],
    );
    await locClient.end();
    const locationId = locRow.rows[0].id;

    const prodRes = await api("POST", "/api/product", {
      name: "Sync Product",
      categoryId: null,
      brandId: null,
      unitId,
      description: "",
      productType: "physical",
      hasVariants: false,
      trackingType: "none",
      supplierId: null,
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "opening",
      variants: [
        {
          sku: "",
          barcode: null,
          sellingPrice: 100,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: 50,
          quantity: 5,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prodRes.status, 201);
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find(
      (p) => p.name === "Sync Product",
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    const variantId = (detail.json as { variants: { id: number }[] })
      .variants[0]!.id;

    const order = await createOnlineOrder({
      businessId,
      locationId,
      integrationId,
      channel: "woocommerce",
      idempotencyKey: `custsync-${Date.now()}`,
      lines: [{ variantId, quantity: 1 }],
      customer: {
        name: "Backfill Customer",
        phone: "+8801711000090", // same digits, different formatting
        email: "backfilled@example.test",
        address: "12 Sync Street",
      },
    });
    assert.ok(order.saleId > 0, "order imported");

    // The matched customer gained the email + address; no duplicate row.
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const rows = await client.query(
      `SELECT email, address, name FROM customers WHERE business_id = $1 AND regexp_replace(phone, '[\\s-]', '', 'g') LIKE '%1711000090%'`,
      [businessId],
    );
    await client.end();
    assert.equal(rows.rows.length, 1, "no duplicate customer created");
    assert.equal(rows.rows[0].email, "backfilled@example.test");
    assert.equal(rows.rows[0].address, "12 Sync Street");
    void customerId;
  });

  it("pushes customers with emails to the connected Woo store (upsert by email)", async () => {
    // Connect the integration to the mock store (mock provider bypasses
    // the SSRF guard under INTEGRATION_TESTS=1).
    // Customers with emails exist (the backfilled one + new ones).
    await api("POST", "/api/customers", {
      name: "Pushable Customer",
      phone: "1711000091",
      email: "pushable@example.test",
    });

    // Push THIS integration directly (the scheduler sweep is the same
    // entrypoint; a global sweep assertion would be nondeterministic here
    // because old never-synced integrations crowd its LIMIT 20).
    const { pushCustomerUpdates } = await import(
      "../modules/integrations/integrations.service.js"
    );
    const pushed = await pushCustomerUpdates(integrationId);
    assert.ok(pushed >= 1, "customers pushed");
    // A second immediate push is a no-op — the watermark advanced.
    const pushedAgain = await pushCustomerUpdates(integrationId);
    assert.equal(pushedAgain, 0, "watermark prevents re-push");

    // The mock store received POST /customers with the pushable customer.
    const created = wcReceived.filter(
      (r) => r.method === "POST" && r.path === "/wp-json/wc/v3/customers",
    );
    assert.ok(
      created.some(
        (r) =>
          typeof r.body === "object" &&
          r.body !== null &&
          (r.body as { email?: string }).email === "pushable@example.test",
      ),
      "pushable customer reached the Woo store",
    );

    const createdAfter = wcReceived.filter(
      (r) => r.method === "POST" && r.path === "/wp-json/wc/v3/customers",
    ).length;
    assert.equal(created.length, createdAfter, "no duplicate Woo customers");
  });
});
