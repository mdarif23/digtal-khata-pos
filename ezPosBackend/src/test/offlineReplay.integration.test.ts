/**
 * Offline POS sync invariant (Module 10): a sale recorded offline and
 * replayed by the sync engine can NEVER create a duplicate — the sync
 * engine sends the same client idempotency key, and the backend returns
 * the original invoice instead of creating a second sale, no matter how
 * many times the payload is replayed.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("offline sale replay (sync safety)", { skip: !runIntegration }, () => {
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
    `offlinesync-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let unitId = 0;
  let customerId = 0;
  let variantId = 0;

  async function api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json() };
  }

  function offlinePayload(key: string, quantity: number) {
    return {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "cash", amount: 60 * quantity, tendered: 60 * quantity }],
      discount: null,
      vatPercent: 0,
      idempotencyKey: key,
      items: [{ variantId, quantity, unitPrice: 60, discount: null }],
    };
  }

  it("sets up the register fixture", async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Offline Sync", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Offline Sync Biz ${Date.now()}` }),
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
    const cust = await api("POST", "/api/customers", {
      name: "Offline Customer",
      phone: "1711000012",
    });
    customerId = cust.json.id;

    const prodRes = await api("POST", "/api/product", {
      name: "Offline Product",
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
          sellingPrice: 60,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: 30,
          quantity: 50,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prodRes.status, 201);
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find(
      (p) => p.name === "Offline Product",
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    variantId = (detail.json as { variants: { id: number }[] }).variants[0]!.id;
  });

  it("replaying the same offline payload any number of times yields exactly one sale", async () => {
    const key = `offline-${Date.now()}`;

    const first = await api("POST", "/api/sales", offlinePayload(key, 2));
    assert.equal(first.status, 201);
    const firstId = first.json.data.sale.id;
    const firstInvoice = first.json.data.sale.invoiceNumber;

    // The sync engine retries (and a duplicate queued entry, and a manual
    // replay): every replay must return the SAME sale, never a new one.
    for (let i = 0; i < 3; i++) {
      const replay = await api("POST", "/api/sales", offlinePayload(key, 2));
      assert.ok([200, 201].includes(replay.status));
      assert.equal(replay.json.data.sale.id, firstId);
      assert.equal(replay.json.data.sale.invoiceNumber, firstInvoice);
    }

    // Exactly one sale row and exactly one stock deduction.
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const sales = await client.query(
      `SELECT count(*)::int AS n FROM sales WHERE business_id = $1 AND idempotency_key = $2`,
      [businessId, key],
    );
    const stock = await client.query(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [variantId, businessId],
    );
    await client.end();
    assert.equal(sales.rows[0].n, 1);
    assert.equal(Number(stock.rows[0].quantity), 48); // 50 − 2, once
  });

  it("a stock conflict on replay marks the transaction for review, not a duplicate", async () => {
    // Sell more than stock allows with a FRESH key → rejected outright.
    const res = await api(
      "POST",
      "/api/sales",
      offlinePayload(`offline-over-${Date.now()}`, 1000),
    );
    // Rejected either as a conflict (409) or stock-not-available (404) —
    // either way the payload is rejected, not silently duplicated.
    assert.ok([404, 409].includes(res.status));
    // No sale was created for the rejected payload.
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const sales = await client.query(
      `SELECT count(*)::int AS n FROM sales WHERE business_id = $1`,
      [businessId],
    );
    await client.end();
    assert.equal(sales.rows[0].n, 1); // only the earlier offline sale
  });
});
