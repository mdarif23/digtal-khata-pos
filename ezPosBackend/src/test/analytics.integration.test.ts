/**
 * Advanced analytics integration tests (Module 15, Phase 8): channel
 * performance split, CLV math, retention (new vs returning), staff
 * attribution, and the forecast shape.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("advanced analytics integration", { skip: !runIntegration }, () => {
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
    `analytics-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let unitId = 0;
  let customerId = 0;
  let variantId = 0;

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

  async function sell(quantity: number, channel?: string) {
    // POS sale via the API; a Woo-channel sale is inserted as fixture data
    // (the online-order entrypoints need an integration + API key — the
    // reporting SQL is what's under test here).
    if (channel === undefined) {
      const res = await api("POST", "/api/sales", {
        saleDate: new Date().toISOString(),
        customerId,
        payments: [{ method: "cash", amount: 50 * quantity, tendered: 50 * quantity }],
        discount: null,
        vatPercent: 0,
        items: [{ variantId, quantity, unitPrice: 50, discount: null }],
      });
      assert.equal(res.status, 201);
      return;
    }
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const loc = await client.query(
      `SELECT id FROM locations WHERE business_id = $1 LIMIT 1`,
      [businessId],
    );
    await client.query(
      `INSERT INTO sales (business_id, location_id, invoice_number, purchase_date, status, channel, subtotal, discount, vat, final_total, due_amount, payment_status, customer_id, idempotency_key)
       VALUES ($1, $2, 'WO-TEST-' || floor(random()*100000)::int, now(), 'completed', $3, $4, 0, 0, $4, 0, 'paid', NULL, 'analytics-woo-' || floor(random()*100000)::int)`,
      [businessId, loc.rows[0].id, channel, 50 * quantity],
    );
    await client.end();
  }

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Analytics Owner", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Analytics Biz ${Date.now()}` }),
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
      name: "Analytics Customer",
      phone: "1711000018",
    });
    customerId = cust.json.id;
    const prodRes = await api("POST", "/api/product", {
      name: "Analytics Product",
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
          sellingPrice: 50,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: 25,
          quantity: 50,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prodRes.status, 201);
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find(
      (p) => p.name === "Analytics Product",
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    variantId = (detail.json as { variants: { id: number }[] }).variants[0]!.id;
  });

  it("generates sales on two channels for the analytics fixtures", async () => {
    await sell(2); // POS: 100
    await sell(1); // POS: 50
    await sell(4, "woocommerce"); // Woo: 200
  });

  it("splits channel performance with order counts and averages", async () => {
    const start = new Date(Date.now() - 86_400_000).toISOString();
    const end = new Date(Date.now() + 86_400_000).toISOString();
    const res = await api(
      "GET",
      `/api/reports/analytics/channels?startDate=${start}&endDate=${end}`,
    );
    assert.equal(res.status, 200);
    const rows = res.json.data as {
      channel: string;
      orders: number;
      revenue: number;
      avgOrderValue: number;
    }[];
    const pos = rows.find((r) => r.channel === "pos");
    const woo = rows.find((r) => r.channel === "woocommerce");
    assert.ok(pos && woo, "both channels present");
    assert.equal(pos.orders, 2);
    assert.equal(pos.revenue, 150);
    assert.equal(woo.orders, 1);
    assert.equal(woo.revenue, 200);
    assert.equal(woo.avgOrderValue, 200);
  });

  it("computes CLV per customer", async () => {
    const res = await api("GET", "/api/reports/analytics/clv");
    assert.equal(res.status, 200);
    const rows = res.json.data as {
      customerId: number;
      orders: number;
      totalSpent: number;
      avgOrderValue: number;
    }[];
    const row = rows.find((r) => r.customerId === customerId)!;
    assert.equal(row.orders, 2); // POS sales only (Woo orders are guests)
    assert.equal(row.totalSpent, 150);
    assert.equal(row.avgOrderValue, 75);
  });

  it("classifies the customer as new in the current month", async () => {
    const res = await api("GET", "/api/reports/analytics/retention");
    assert.equal(res.status, 200);
    const rows = res.json.data as {
      month: string;
      newCustomers: number;
      totalActive: number;
    }[];
    const current = rows[rows.length - 1]!;
    assert.ok(current.totalActive >= 1);
    assert.ok(current.newCustomers >= 1);
  });

  it("attributes POS sales to the cashier for staff performance", async () => {
    const start = new Date(Date.now() - 86_400_000).toISOString();
    const end = new Date(Date.now() + 86_400_000).toISOString();
    const res = await api(
      "GET",
      `/api/reports/analytics/staff?startDate=${start}&endDate=${end}`,
    );
    assert.equal(res.status, 200);
    const rows = res.json.data as {
      cashierName: string;
      orders: number;
      revenue: number;
    }[];
    assert.ok(rows.length >= 1, "cashier attribution present");
    const top = rows[0]!;
    assert.equal(top.orders, 2);
    assert.equal(top.revenue, 150);
  });

  it("returns a forecast with 90 days of history and a 7-day projection", async () => {
    const res = await api("GET", "/api/reports/analytics/forecast");
    assert.equal(res.status, 200);
    const data = res.json.data as {
      history: { date: string; actualRevenue: number | null; projectedRevenue: number }[];
      projection: { next7DaysTotal: number; trendPerDay: number };
      method: string;
    };
    assert.equal(data.history.length, 97); // 90 actual + 7 projected
    assert.ok(data.projection.next7DaysTotal >= 0);
    assert.match(data.method, /statistical estimate/);
  });
});
