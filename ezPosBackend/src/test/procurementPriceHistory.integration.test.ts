/**
 * Smart Procurement Phase 1 — product price history integration tests.
 *
 * Verifies that price history derives from RECEIVED purchase lines only:
 * fully received, partially received (received quantity only), and that
 * ordered-but-unreceived purchases never enter the history. Also covers
 * supplier comparison, percent-change math, filters, pagination,
 * tenancy isolation, and authorization.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("procurement price history integration", { skip: !runIntegration }, () => {
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
    `proc-${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

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
        fullName: "Procurement Test",
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
      body: JSON.stringify({ name: `Procurement Biz ${prefix} ${Date.now()}` }),
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
        const body = await res
          .clone()
          .json()
          .catch(() => null);
        console.error(`API ${method} ${path} -> ${res.status}:`, JSON.stringify(body));
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
          sellingPrice: 100,
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

  /** Creates a purchase and returns its single line item id. */
  async function createPurchase(
    price: number,
    quantity: number,
    supplierId: number | null,
  ): Promise<number> {
    const res = await api("POST", "/api/purchases", {
      items: [
        { variantId, quantity, purchasePrice: price, discount: 0, tax: 0 },
      ],
      supplierId,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      notes: "price history fixture",
    });
    assert.equal(res.status, 201);
    const items = await api("GET", "/api/purchases/items");
    assert.equal(items.status, 200);
    const rows = items.json as {
      id: number;
      variantId: number;
      purchaseId: number;
    }[];
    // Freshly created purchase = the item we have not consumed yet.
    const row = rows
      .filter((r) => r.variantId === variantId)
      .sort((a, b) => b.id - a.id)[0]!;
    return row.id;
  }

  async function receive(itemId: number, qty: number, unitCost: number) {
    const items = await api("GET", "/api/purchases/items");
    const rows = items.json as { id: number; purchaseId: number }[];
    const purchaseId = rows.find((r) => r.id === itemId)!.purchaseId;
    const res = await api("POST", "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: qty,
          unitCost,
          sellingPrice: 100,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(res.status, 201);
  }

  before(async () => {
    ctx = await registerAndCreateBusiness("a");
    api = apiFor(ctx);
    const unit = await api("POST", "/api/product/unit", {
      unitName: "Bag",
      abbreviation: "Bag",
    });
    unitId = (unit.json as { data: { value: number } }).data.value;
    const supA = await api("POST", "/api/contacts/supplier", {
      supplierName: "Wholesale A",
      phone: "+8801711000001",
      email: null,
      address: null,
    });
    supplierA = (supA.json as { data: { supplierId: number } }).data.supplierId;
    const supB = await api("POST", "/api/contacts/supplier", {
      supplierName: "Wholesale B",
      phone: "+8801711000002",
      email: null,
      address: null,
    });
    supplierB = (supB.json as { data: { supplierId: number } }).data.supplierId;
    variantId = await createVariant("Price Watch Widget");

    // P1: fully received from A @100 (qty 10)
    // P2: fully received from A @120 (qty 5)
    // P3: fully received from B @90  (qty 8)
    // P4: ordered from A @130, NEVER received (must be excluded)
    // P5: partially received from B @110 (4 of 10)
    const p1 = await createPurchase(100, 10, supplierA);
    await receive(p1, 10, 100);
    const p2 = await createPurchase(120, 5, supplierA);
    await receive(p2, 5, 120);
    const p3 = await createPurchase(90, 8, supplierB);
    await receive(p3, 8, 90);
    await createPurchase(130, 7, supplierA); // stays ordered/unreceived
    const p5 = await createPurchase(110, 10, supplierB);
    await receive(p5, 4, 110);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`${baseUrl}/api/procurement/price-overview`);
    assert.equal(res.status, 401);
  });

  it("aggregates received prices per variant (overview)", async () => {
    const res = await api("GET", "/api/procurement/price-overview");
    assert.equal(res.status, 200);
    const body = res.json as {
      success: boolean;
      data: {
        data: {
          variantId: number;
          latestPrice: number | null;
          previousPrice: number | null;
          lowestPrice: number;
          highestPrice: number;
          averagePrice: number | null;
          purchaseCount: number;
          totalReceivedQuantity: number;
          lastSupplierId: number | null;
          priceChangePercent: number | null;
        }[];
        total: number;
        page: number;
        limit: number;
      };
    };
    assert.equal(body.success, true);
    assert.equal(body.data.total, 1);
    const row = body.data.data.find((r) => r.variantId === variantId);
    assert.ok(row, "variant with received purchases listed");
    assert.equal(row.latestPrice, 110); // P5 (created last)
    assert.equal(row.previousPrice, 90); // P3
    assert.equal(row.lowestPrice, 90);
    assert.equal(row.highestPrice, 120);
    assert.equal(row.averagePrice, 102.22); // (1000+600+720+440)/27
    assert.equal(row.purchaseCount, 4); // ordered P4 excluded
    assert.equal(row.totalReceivedQuantity, 27); // partial counted as 4
    assert.equal(row.lastSupplierId, supplierB);
    assert.equal(row.priceChangePercent, 22.22); // (110-90)/90
  });

  it("filters the overview by supplier and search", async () => {
    const bySupplier = await api(
      "GET",
      `/api/procurement/price-overview?supplierId=${supplierA}`,
    );
    assert.equal(bySupplier.status, 200);
    const sup = (bySupplier.json as typeof overviewShape).data.data[0];
    assert.ok(sup, "row present when filtered by supplier A");
    assert.equal(sup.purchaseCount, 2);
    assert.equal(sup.latestPrice, 120);
    assert.equal(sup.previousPrice, 100);
    assert.equal(sup.averagePrice, 106.67); // (1000+600)/15
    assert.equal(sup.priceChangePercent, 20);

    const noMatch = await api(
      "GET",
      "/api/procurement/price-overview?search=does-not-exist",
    );
    assert.equal((noMatch.json as typeof overviewShape).data.total, 0);

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const future = await api(
      "GET",
      `/api/procurement/price-overview?from=${tomorrow}`,
    );
    assert.equal((future.json as typeof overviewShape).data.total, 0);
  });

  // Shared type only for casts in assertions above.
  const overviewShape = {
    success: true,
    data: {
      data: [
        {
          variantId: 0,
          latestPrice: 0,
          previousPrice: 0,
          lowestPrice: 0,
          highestPrice: 0,
          averagePrice: 0,
          purchaseCount: 0,
          totalReceivedQuantity: 0,
          lastSupplierId: 0,
          priceChangePercent: 0,
        },
      ],
      total: 0,
      page: 1,
      limit: 50,
    },
  } as const;

  it("returns full price history detail with supplier comparison", async () => {
    const res = await api(
      "GET",
      `/api/procurement/variants/${variantId}/price-history`,
    );
    assert.equal(res.status, 200);
    const data = (res.json as { success: boolean; data: {
      variant: { variantId: number; productName: string; unitName: string | null };
      summary: {
        latestPrice: number | null;
        previousPrice: number | null;
        lowestPrice: number | null;
        highestPrice: number | null;
        averagePrice: number | null;
        purchaseCount: number;
        priceChangePercent: number | null;
      };
      suppliers: {
        supplierId: number | null;
        latestPrice: number | null;
        previousPrice: number | null;
        lowestPrice: number;
        highestPrice: number;
        averagePrice: number | null;
        purchaseCount: number;
        priceChangePercent: number | null;
      }[];
      records: {
        data: { unitCost: number; receivedQuantity: number; supplierId: number | null }[];
        total: number;
      };
    } }).data;

    assert.equal(data.variant.variantId, variantId);
    assert.equal(data.summary.purchaseCount, 4);
    assert.equal(data.summary.latestPrice, 110);
    assert.equal(data.summary.previousPrice, 90);
    assert.equal(data.summary.priceChangePercent, 22.22);

    // Cheapest latest price first (B @110 beats A @120).
    assert.equal(data.suppliers.length, 2);
    const first = data.suppliers[0]!;
    const second = data.suppliers[1]!;
    assert.equal(first.supplierId, supplierB);
    assert.equal(first.latestPrice, 110);
    assert.equal(first.previousPrice, 90);
    assert.equal(first.lowestPrice, 90);
    assert.equal(first.highestPrice, 110);
    assert.equal(first.averagePrice, 96.67); // (720+440)/12
    assert.equal(first.purchaseCount, 2);
    assert.equal(first.priceChangePercent, 22.22);
    assert.equal(second.supplierId, supplierA);
    assert.equal(second.latestPrice, 120);
    assert.equal(second.averagePrice, 106.67);

    // Records exclude the unreceived P4 → 4 events.
    assert.equal(data.records.total, 4);
    assert.equal(data.records.data[0]?.unitCost, 110);
    assert.equal(data.records.data[0]?.receivedQuantity, 4);
    assert.ok(
      !data.records.data.some((r) => r.unitCost === 130),
      "unreceived purchase must not appear in price records",
    );
  });

  it("paginates price records", async () => {
    const res = await api(
      "GET",
      `/api/procurement/variants/${variantId}/price-history?page=1&limit=2`,
    );
    assert.equal(res.status, 200);
    const records = (res.json as { data: { records: { data: unknown[]; total: number; page: number; limit: number } } })
      .data.records;
    assert.equal(records.data.length, 2);
    assert.equal(records.total, 4);
    assert.equal(records.page, 1);
    assert.equal(records.limit, 2);
  });

  it("404s for a variant outside the business", async () => {
    const res = await api("GET", "/api/procurement/variants/999999/price-history");
    assert.equal(res.status, 404);
  });

  it("isolates tenants — another business sees nothing", async () => {
    const other = await registerAndCreateBusiness("b");
    const otherApi = apiFor(other);
    const overview = await otherApi("GET", "/api/procurement/price-overview");
    assert.equal((overview.json as { data: { total: number } }).data.total, 0);
    const detail = await otherApi(
      "GET",
      `/api/procurement/variants/${variantId}/price-history`,
    );
    assert.equal(detail.status, 404);
  });

  it("validates query parameters", async () => {
    const res = await api(
      "GET",
      "/api/procurement/price-overview?from=not-a-date",
    );
    assert.equal(res.status, 400);
    const page = await api(
      "GET",
      "/api/procurement/price-overview?page=0",
    );
    assert.equal(page.status, 400);
  });
});
