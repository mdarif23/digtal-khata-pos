/**
 * Coupon integration tests (Module 6): server-validated codes with
 * windows, order minimums, discount caps, total + per-customer usage
 * limits, and redemption history. The quote previews the exact discount;
 * createSale applies and records it atomically.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("coupons integration", { skip: !runIntegration }, () => {
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
    `coupon-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

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

  /** Sale of a ৳100 line; `paid` must match the coupon-adjusted total. */
  async function sale(couponCode?: string, paid = 100) {
    return api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      couponCode,
      payments: [{ method: "cash", amount: paid, tendered: paid }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 100, discount: null }],
    });
  }

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Coupon Test", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Coupon Biz ${Date.now()}` }),
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
      name: "Coupon Customer",
      phone: "1711000016",
    });
    customerId = cust.json.id;
    const prodRes = await api("POST", "/api/product", {
      name: "Coupon Product",
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
          quantity: 50,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prodRes.status, 201);
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find(
      (p) => p.name === "Coupon Product",
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    variantId = (detail.json as { variants: { id: number }[] }).variants[0]!.id;
  });

  it("creates a 10% coupon with a minimum and cap; the quote previews the exact discount", async () => {
    const create = await api("POST", "/api/coupons", {
      code: "SAVE10",
      discountType: "percentage",
      value: 10,
      minOrderAmount: 50,
      maxDiscountAmount: 25,
      description: "10% off, cap ৳25",
    });
    assert.equal(create.status, 201);

    const quote = await api("POST", "/api/sales/quote", {
      items: [{ variantId, quantity: 1, discount: null }],
      cartDiscount: null,
      vatPercent: 0,
      couponCode: "save10", // case-insensitive
      customerId,
    });
    assert.equal(quote.status, 200);
    const data = quote.json.data as {
      finalTotal: number;
      coupon?: { code: string; discountAmount: number };
    };
    assert.equal(data.coupon?.code, "SAVE10");
    assert.equal(data.coupon?.discountAmount, 10); // 10% of 100, cap 25 not hit
    assert.equal(data.finalTotal, 90);
  });

  it("applies the coupon at sale time and records the redemption", async () => {
    const s = await sale("SAVE10", 90);
    assert.equal(s.status, 201);
    const saleData = (s.json as { data: { sale: { id: number; finalTotal: number } } })
      .data.sale;
    assert.equal(Number(saleData.finalTotal), 90);

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const redemption = await client.query(
      `SELECT discount_amount FROM coupon_redemptions WHERE sale_id = $1`,
      [saleData.id],
    );
    const used = await client.query(
      `SELECT used_count FROM coupons WHERE upper(code) = 'SAVE10'`,
    );
    await client.end();
    assert.equal(Number(redemption.rows[0].discount_amount), 10);
    assert.equal(Number(used.rows[0].used_count), 1);
  });

  it("enforces the per-customer limit and blocks reuse", async () => {
    // Create a per-customer-limited coupon and exhaust it.
    const create = await api("POST", "/api/coupons", {
      code: "ONCE",
      discountType: "fixed",
      value: 20,
      perCustomerLimit: 1,
    });
    assert.equal(create.status, 201);

    const first = await sale("ONCE", 80);
    assert.equal(first.status, 201);
    const second = await sale("ONCE");
    assert.equal(second.status, 400);
    assert.match(second.json.message ?? "", /maximum number of times/);
  });

  it("enforces the usage limit and the validity window", async () => {
    const create = await api("POST", "/api/coupons", {
      code: "TWICE",
      discountType: "fixed",
      value: 5,
      usageLimit: 2,
    });
    assert.equal(create.status, 201);
    assert.equal((await sale("TWICE", 95)).status, 201);
    assert.equal((await sale("TWICE", 95)).status, 201);
    const third = await sale("TWICE");
    assert.equal(third.status, 400);
    assert.match(third.json.message ?? "", /usage limit/);

    const future = await api("POST", "/api/coupons", {
      code: "FUTURE",
      discountType: "fixed",
      value: 5,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    assert.equal(future.status, 201);
    const early = await sale("FUTURE");
    assert.equal(early.status, 400);
    assert.match(early.json.message ?? "", /starts on/);
  });

  it("enforces the order minimum and rejects unknown codes", async () => {
    const create = await api("POST", "/api/coupons", {
      code: "BIGMIN",
      discountType: "fixed",
      value: 10,
      minOrderAmount: 500,
    });
    assert.equal(create.status, 201);
    const nope = await sale("BIGMIN");
    assert.equal(nope.status, 400);
    assert.match(nope.json.message ?? "", /minimum order/);

    const unknown = await sale("NO-SUCH-COUPON");
    assert.equal(unknown.status, 404);
  });

  it("rejects combining a coupon with a cart discount (v1 stacking rule)", async () => {
    const res = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      couponCode: "SAVE10",
      payments: [{ method: "cash", amount: 90, tendered: 90 }],
      discount: { type: "fixed", value: 10 },
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 100, discount: null }],
    });
    assert.equal(res.status, 400);
    assert.match(res.json.message ?? "", /not both/);
  });

  it("inactive coupons are rejected at creation time of the sale", async () => {
    const create = await api("POST", "/api/coupons", {
      code: "PAUSED",
      discountType: "fixed",
      value: 5,
      isActive: false,
    });
    assert.equal(create.status, 201);
    const res = await sale("PAUSED");
    assert.equal(res.status, 400);
    assert.match(res.json.message ?? "", /no longer active/);
  });
});
