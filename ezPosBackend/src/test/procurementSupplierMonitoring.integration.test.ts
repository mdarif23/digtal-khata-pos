/**
 * Smart Procurement Phase 3 — supplier price monitoring + increase alerts.
 *
 * Verifies: supplier detail/stats, supplier-scoped price history with
 * quotations, the supplier-variant trend, alert settings read/update with
 * permission gating (owner yes, accountant no), and receive-time
 * `price_increase` detection: fires once per price event, only when
 * enabled, only above the configured threshold, never on decreases.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("supplier price monitoring integration", { skip: !runIntegration }, () => {
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

  const uniqueEmail = (prefix: string) =>
    `smon-${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  interface Ctx {
    token: string;
    businessId: number;
  }

  async function registerAndCreateBusiness(prefix: string): Promise<Ctx> {
    const email = uniqueEmail(prefix);
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Supplier Monitor Test",
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
    const token = ((await login.json()) as { accessToken: string }).accessToken;
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: `Supplier Monitor Biz ${prefix} ${Date.now()}` }),
    });
    assert.equal(biz.status, 201);
    const businessId = ((await biz.json()) as { business: { id: number } }).business.id;
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
    return { token, businessId };
  }

  function apiFor(ctx: Ctx) {
    return async function api(method: string, path: string, body?: unknown) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.token}`,
          "X-Business-Id": String(ctx.businessId),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok && res.status >= 400) {
        const errBody = await res.clone().json().catch(() => null);
        console.error(`API ${method} ${path} -> ${res.status}:`, JSON.stringify(errBody));
      }
      return { status: res.status, json: await res.json() };
    };
  }

  let ctx: Ctx;
  let api: ReturnType<typeof apiFor>;
  let unitId = 0;
  let supplierA = 0;
  let supplierB = 0;
  let variantId = 0;

  async function createVariant(name: string): Promise<number> {
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
          sellingPrice: 300,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: 40,
          quantity: 5,
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

  /** Fully receives a purchase at the given unit cost. */
  async function receivePurchase(price: number, quantity: number, supplierId: number) {
    const create = await api("POST", "/api/purchases", {
      items: [{ variantId, quantity, purchasePrice: price, discount: 0, tax: 0 }],
      supplierId,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
    });
    assert.equal(create.status, 201);
    const items = await api("GET", "/api/purchases/items");
    const rows = items.json as { id: number; variantId: number; purchaseId: number }[];
    const line = rows
      .filter((r) => r.variantId === variantId)
      .sort((a, b) => b.id - a.id)[0]!;
    const receive = await api("POST", "/api/purchases/receive", {
      purchaseId: line.purchaseId,
      items: [
        {
          itemId: line.id,
          trackingType: "none",
          receiveNow: quantity,
          unitCost: price,
          sellingPrice: 300,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(receive.status, 201);
  }

  before(async () => {
    ctx = await registerAndCreateBusiness("a");
    api = apiFor(ctx);
    const unit = await api("POST", "/api/product/unit", {
      unitName: "Box",
      abbreviation: "Box",
    });
    unitId = (unit.json as { data: { value: number } }).data.value;
    const supA = await api("POST", "/api/contacts/supplier", {
      supplierName: "Distributor A",
      phone: "+8801711000021",
      email: null,
      address: null,
    });
    supplierA = (supA.json as { data: { supplierId: number } }).data.supplierId;
    const supB = await api("POST", "/api/contacts/supplier", {
      supplierName: "Distributor B",
      phone: "+8801711000022",
      email: null,
      address: null,
    });
    supplierB = (supB.json as { data: { supplierId: number } }).data.supplierId;
    variantId = await createVariant("Alert Widget");

    // Alerts are DISABLED by default: these increases must stay silent.
    await receivePurchase(100, 10, supplierA); // first price from A
    await receivePurchase(120, 5, supplierA); // +20% — disabled, no alert

    // Owner enables a 10% threshold.
    const put = await api("PUT", "/api/procurement/alert-settings", {
      enabled: true,
      increaseThresholdPercent: 10,
    });
    assert.equal(put.status, 200);

    await receivePurchase(135, 4, supplierA); // +12.5% vs 120 → ALERT
    await receivePurchase(140, 3, supplierA); // +3.7% vs 135 → below threshold
    await receivePurchase(100, 2, supplierA); // decrease → never alerts
    await receivePurchase(50, 3, supplierB); // B's first price → no baseline

    // A quotation from supplier A feeds the history's quotation column.
    const obs = await api("POST", "/api/procurement/price-check", {
      variantId,
      supplierId: supplierA,
      quotedPrice: 150,
    });
    assert.equal(obs.status, 201);
  });

  it("reads and updates alert settings with permission gating", async () => {
    const get = await api("GET", "/api/procurement/alert-settings");
    assert.equal(get.status, 200);
    assert.deepEqual(
      (get.json as { data: { enabled: boolean; increaseThresholdPercent: number } }).data,
      { enabled: true, increaseThresholdPercent: 10 },
    );

    const invalid = await api("PUT", "/api/procurement/alert-settings", {
      enabled: true,
      increaseThresholdPercent: 0,
    });
    assert.equal(invalid.status, 400);

    // Accountant has purchases.view but not purchases.manage_price_alerts.
    const rolesRes = await api("GET", "/api/roles");
    const rolesBody = rolesRes.json as { data?: { id: number; slug: string }[] };
    const roles = Array.isArray(rolesBody) ? rolesBody : rolesBody.data ?? [];
    const accountantRoleId = roles.find((r) => r.slug === "accountant")!.id;
    const email = uniqueEmail("accountant");
    const created = await api("POST", "/api/users", {
      fullName: "Monitoring Accountant",
      email,
      password: "strong-password-123",
      roleIds: [accountantRoleId],
    });
    assert.equal(created.status, 201);
    const userId = (created.json as { data: { userId: number } }).data.userId;
    const locations = await api("GET", "/api/locations");
    const locationId = (locations.json as { data: { id: number }[] }).data[0]!.id;
    await api("PATCH", `/api/users/${userId}`, { locationIds: [locationId] });
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    const accountantApi = apiFor({
      token: ((await login.json()) as { accessToken: string }).accessToken,
      businessId: ctx.businessId,
    });

    const putForbidden = await accountantApi("PUT", "/api/procurement/alert-settings", {
      enabled: false,
      increaseThresholdPercent: 10,
    });
    assert.equal(putForbidden.status, 403);
    const getAllowed = await accountantApi("GET", "/api/procurement/alert-settings");
    assert.equal(getAllowed.status, 200);
    const historyAllowed = await accountantApi(
      "GET",
      `/api/procurement/suppliers/${supplierA}/price-history`,
    );
    assert.equal(historyAllowed.status, 200);
  });

  it("fires exactly one factual price_increase notification at the threshold", async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const result = await client.query(
      `SELECT title, body, payload, dedupe_key FROM notifications
       WHERE business_id = $1 AND kind = 'price_increase'`,
      [ctx.businessId],
    );
    await client.end();

    assert.equal(result.rows.length, 1, "exactly one alert for the one qualifying event");
    const row = result.rows[0] as {
      title: string;
      body: string;
      payload: Record<string, unknown>;
      dedupe_key: string;
    };
    assert.ok(row.title.includes("Alert Widget"));
    assert.ok(row.body.includes("120.00"), "previous price in body");
    assert.ok(row.body.includes("135.00"), "current price in body");
    assert.ok(row.body.includes("+12.5%"), "percent in body");
    assert.equal(row.payload.previousPrice, 120);
    assert.equal(row.payload.currentPrice, 135);
    assert.equal(row.payload.percentChange, 12.5);
    assert.ok(
      row.dedupe_key.startsWith(
        `price_increase:${ctx.businessId}:${variantId}:${supplierA}:`,
      ),
      "dedupe key encodes the price event",
    );
  });

  it("returns supplier detail with received-value statistics", async () => {
    const res = await api("GET", `/api/procurement/suppliers/${supplierA}`);
    assert.equal(res.status, 200);
    const data = (res.json as { data: {
      supplier: { id: number; name: string; minimumOrderValue: number | null };
      stats: {
        purchaseCount: number;
        totalReceivedValue: number;
        productCount: number;
        lastPurchaseDate: string | null;
      };
    } }).data;
    assert.equal(data.supplier.id, supplierA);
    assert.equal(data.supplier.name, "Distributor A");
    assert.equal(data.supplier.minimumOrderValue, null);
    assert.equal(data.stats.purchaseCount, 5); // A received five purchases
    assert.equal(data.stats.totalReceivedValue, 2760); // 1000+600+540+420+200
    assert.equal(data.stats.productCount, 1);
    assert.ok(data.stats.lastPurchaseDate);
  });

  it("returns supplier-scoped price history with quotations", async () => {
    const res = await api(
      "GET",
      `/api/procurement/suppliers/${supplierA}/price-history`,
    );
    assert.equal(res.status, 200);
    const data = (res.json as { data: {
      data: {
        variantId: number;
        latestPrice: number | null;
        previousPrice: number | null;
        lowestPrice: number;
        highestPrice: number;
        averagePrice: number | null;
        purchaseCount: number;
        priceChangePercent: number | null;
        latestQuotation: number | null;
      }[];
      total: number;
    } }).data;
    assert.equal(data.total, 1);
    const row = data.data[0]!;
    assert.equal(row.variantId, variantId);
    assert.equal(row.latestPrice, 100); // P5 (created last)
    assert.equal(row.previousPrice, 140);
    assert.equal(row.lowestPrice, 100);
    assert.equal(row.highestPrice, 140);
    assert.equal(row.averagePrice, 115); // 2760 / 24
    assert.equal(row.purchaseCount, 5);
    assert.equal(row.priceChangePercent, -28.57); // (100-140)/140
    assert.equal(row.latestQuotation, 150); // supplier A's observation

    const noMatch = await api(
      "GET",
      `/api/procurement/suppliers/${supplierA}/price-history?search=does-not-exist`,
    );
    assert.equal((noMatch.json as { data: { total: number } }).data.total, 0);
  });

  it("returns the supplier-variant trend chronologically", async () => {
    const res = await api(
      "GET",
      `/api/procurement/suppliers/${supplierA}/trend?variantId=${variantId}`,
    );
    assert.equal(res.status, 200);
    const events = (res.json as { data: { unitCost: number }[] }).data;
    assert.deepEqual(
      events.map((event) => event.unitCost),
      [100, 120, 135, 140, 100],
    );
  });

  it("isolates tenants — foreign suppliers are 404", async () => {
    const other = await registerAndCreateBusiness("b");
    const otherApi = apiFor(other);
    const detail = await otherApi("GET", `/api/procurement/suppliers/${supplierA}`);
    assert.equal(detail.status, 404);
    const history = await otherApi(
      "GET",
      `/api/procurement/suppliers/${supplierA}/price-history`,
    );
    assert.equal(history.status, 404);
  });
});
