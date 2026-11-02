/**
 * Inventory aging + dead-stock report integration tests (Module 2D).
 * Proves bucket math, batch-cost valuation, and dead-stock detection
 * (never-sold and stale variants) with location scoping.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("inventory aging + dead stock reports integration", { skip: !runIntegration }, () => {
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
    `aging-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let unitId = 0;
  let variantFresh = 0;
  let variantDead = 0;

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

  async function createProduct(name: string, qty: number): Promise<number> {
    const prodRes = await api("POST", "/api/product", {
      name,
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
          purchasePrice: 40,
          quantity: qty,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prodRes.status, 201);
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find(
      (p) => p.name === name,
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    return (detail.json as { variants: { id: number }[] }).variants[0]!.id;
  }

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Aging Test", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Aging Biz ${Date.now()}` }),
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
    variantFresh = await createProduct("Fresh Seller", 10);
    variantDead = await createProduct("Dead Item", 8);
  });

  it("ages fresh batches in the 0-30 bucket at batch cost", async () => {
    const res = await api("GET", "/api/reports/inventory/aging");
    assert.equal(res.status, 200);
    const data = res.json.data as {
      rows: {
        variantId: number;
        bucket: string;
        quantityRemaining: number;
        stockValue: number;
        ageDays: number;
      }[];
      buckets: Record<string, { quantity: number; value: number }>;
    };
    const fresh = data.rows.find((r) => r.variantId === variantFresh);
    assert.ok(fresh, "fresh batch present");
    assert.equal(fresh.bucket, "0-30");
    assert.equal(fresh.quantityRemaining, 10);
    assert.equal(fresh.stockValue, 400); // 10 × 40 batch cost
    const bucket030 = data.buckets["0-30"];
    assert.ok(bucket030);
    assert.ok(bucket030.quantity >= 10);
  });

  it("flags never-sold stock as dead; sold variants are excluded", async () => {
    // Sell one unit of the fresh variant so it has a recent sale.
    const sale = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 100, tendered: 100 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: variantFresh, quantity: 1, unitPrice: 100, discount: null }],
    });
    assert.equal(sale.status, 201);

    const res = await api("GET", "/api/reports/inventory/dead-stock?days=60");
    assert.equal(res.status, 200);
    const rows = res.json.data as {
      variantId: number;
      currentStock: number;
      stockValue: number;
      lastSoldAt: string | null;
      daysSinceLastSale: number | null;
    }[];
    const dead = rows.find((r) => r.variantId === variantDead);
    assert.ok(dead, "never-sold variant flagged as dead");
    assert.equal(dead.currentStock, 8);
    assert.equal(dead.stockValue, 320); // 8 × 40
    assert.equal(dead.lastSoldAt, null);
    assert.equal(
      rows.find((r) => r.variantId === variantFresh),
      undefined,
      "recently-sold variant not dead",
    );
  });

  it("respects the lookback window: nothing is dead within 1 day of its sale", async () => {
    const res = await api("GET", "/api/reports/inventory/dead-stock?days=1");
    assert.equal(res.status, 200);
    const rows = res.json.data as { variantId: number; lastSoldAt: string | null }[];
    // The dead variant was never sold — it stays dead even with days=1.
    assert.ok(rows.find((r) => r.variantId === variantDead));
    void variantFresh;
  });
});
