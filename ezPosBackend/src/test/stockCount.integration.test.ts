/**
 * Stock-count session integration tests (Module 2: stocktaking + cycle
 * counting). Proves the count lifecycle, partial counts, and the core
 * concurrency invariant: the approved variance is counted − CURRENT stock
 * (not the frozen expectation), so a sale between counting and approval
 * cannot produce a wrong adjustment.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("stock count sessions integration", { skip: !runIntegration }, () => {
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
    `stockcount-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let unitId = 0;
  let customerId = 0;
  let variantId = 0;
  let secondVariantId = 0;

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
          sellingPrice: 50,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: 25,
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

  async function stockQuantity(variant: number): Promise<number> {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const res = await client.query(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [variant, businessId],
    );
    await client.end();
    return Number(res.rows[0].quantity);
  }

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Counter", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Count Biz ${Date.now()}` }),
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
      name: "Count Customer",
      phone: "1711000013",
    });
    customerId = cust.json.id;
    variantId = await createProduct("Count Product", 50);
    secondVariantId = await createProduct("Count Product B", 20);
  });

  it("creates a whole-location count session and freezes expected quantities", async () => {
    const res = await api("POST", "/api/stock-counts", { note: "Full stocktake" });
    assert.equal(res.status, 201);
    const sessionId = res.json.data.sessionId;
    assert.ok(res.json.data.lineCount >= 2);

    const detail = await api("GET", `/api/stock-counts/${sessionId}`);
    assert.equal(detail.status, 200);
    const lines = detail.json.data.lines as {
      variantId: number;
      expectedQuantity: number;
      countedQuantity: number | null;
    }[];
    const line = lines.find((l) => l.variantId === variantId)!;
    assert.equal(line.expectedQuantity, 50);
    assert.equal(line.countedQuantity, null);
  });

  it("records partial counts and leaves uncounted lines untouched", async () => {
    const create = await api("POST", "/api/stock-counts", {});
    const sessionId = create.json.data.sessionId;
    const res = await api("POST", `/api/stock-counts/${sessionId}/counts`, {
      counts: [{ variantId, countedQuantity: 47 }],
    });
    assert.equal(res.status, 200);

    const detail = await api("GET", `/api/stock-counts/${sessionId}`);
    const lines = detail.json.data.lines as {
      variantId: number;
      countedQuantity: number | null;
    }[];
    assert.equal(
      lines.find((l) => l.variantId === variantId)!.countedQuantity,
      47,
    );
    assert.equal(
      lines.find((l) => l.variantId === secondVariantId)!.countedQuantity,
      null,
    );

    // Approving a fully-uncounted session is refused; this one has a count.
    const approve = await api("POST", `/api/stock-counts/${sessionId}/approve`);
    assert.equal(approve.status, 200);
    assert.equal(approve.json.data.adjustmentsApplied, 1);

    // Stock corrected 50 → 47; the uncounted variant is untouched.
    assert.equal(await stockQuantity(variantId), 47);
    assert.equal(await stockQuantity(secondVariantId), 20);

    // A completed session accepts no further counts.
    const again = await api("POST", `/api/stock-counts/${sessionId}/counts`, {
      counts: [{ variantId, countedQuantity: 99 }],
    });
    assert.equal(again.status, 409);
  });

  it("applies counted − CURRENT stock at approval, surviving concurrent sales", async () => {
    // 1. Open a session; the expected snapshot says 47.
    const create = await api("POST", "/api/stock-counts", {
      variantIds: [variantId],
    });
    assert.equal(create.status, 201);
    const sessionId = create.json.data.sessionId;

    // 2. Count says 50 on the shelf...
    await api("POST", `/api/stock-counts/${sessionId}/counts`, {
      counts: [{ variantId, countedQuantity: 50 }],
    });

    // 3. ...but a sale of 3 happens BEFORE approval (47 now on the system).
    const sale = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "cash", amount: 150, tendered: 150 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 3, unitPrice: 50, discount: null }],
    });
    assert.equal(sale.status, 201);
    assert.equal(await stockQuantity(variantId), 44);

    // 4. Approval applies 50 − 44 = +6 (NOT 50 − 47 = +3).
    const approve = await api("POST", `/api/stock-counts/${sessionId}/approve`);
    assert.equal(approve.status, 200);
    assert.equal(await stockQuantity(variantId), 50);

    // Movement trail records the adjustment against the session.
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const movements = await client.query(
      `SELECT quantity FROM inventory_movements
       WHERE reference_type = 'stock_count_session' AND reference_id = $1`,
      [sessionId],
    );
    await client.end();
    assert.equal(Number(movements.rows[0].quantity), 6);
  });

  it("cancels open sessions without touching stock", async () => {
    const create = await api("POST", "/api/stock-counts", {});
    const sessionId = create.json.data.sessionId;
    const cancel = await api("POST", `/api/stock-counts/${sessionId}/cancel`);
    assert.equal(cancel.status, 200);
    assert.equal(await stockQuantity(variantId), 50);
    const cancelAgain = await api("POST", `/api/stock-counts/${sessionId}/cancel`);
    assert.equal(cancelAgain.status, 409);
  });
});
