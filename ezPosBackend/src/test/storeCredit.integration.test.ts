/**
 * Store credit ledger integration tests (Module 5, Phase 1 tail).
 *
 * Covers: refund → credit grant → balance endpoint, spending credit on a
 * sale (full + partial with due), insufficient balance rejection,
 * customerless sale rejection, and ledger reconciliation.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("store credit ledger integration", { skip: !runIntegration }, () => {
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
    `credit-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

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
    if (!res.ok) {
      console.error(
        `API ${method} ${path} -> ${res.status}:`,
        JSON.stringify(await res.clone().json().catch(() => null)),
      );
    }
    return { status: res.status, json: await res.json() };
  }

  async function createCashSale(price: number): Promise<{ saleId: number; saleItemId: number }> {
    const res = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "cash", amount: price, tendered: price }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: price, discount: null }],
    });
    assert.equal(res.status, 201);
    const saleId = (res.json as { data: { sale: { id: number } } }).data.sale.id;
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const item = await client.query(
      `SELECT id FROM sale_items WHERE sale_id = $1 LIMIT 1`,
      [saleId],
    );
    await client.end();
    return { saleId, saleItemId: item.rows[0].id };
  }

  async function creditBalance(): Promise<number> {
    const res = await api("GET", `/api/customers/${customerId}/store-credit`);
    assert.equal(res.status, 200);
    return Number((res.json as { data: { balance: number } }).data.balance);
  }

  it("sets up the business, customer, and product", async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Credit Test", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Credit Biz ${Date.now()}` }),
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
      name: "Credit Customer",
      phone: "1711000011",
    });
    assert.equal(cust.status, 201);
    customerId = cust.json.id;

    const prodRes = await api("POST", "/api/product", {
      name: "Credit Product",
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
          quantity: 20,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prodRes.status, 201);
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find(
      (p) => p.name === "Credit Product",
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    variantId = (detail.json as { variants: { id: number }[] }).variants[0]!.id;
  });

  it("starts at zero balance; a store-credit refund grants spendable balance", async () => {
    assert.equal(await creditBalance(), 0);

    const { saleItemId } = await createCashSale(100);
    const refund = await api("POST", `/api/sold_products/refund/${saleItemId}`, {
      reason: "customer_request",
      disposition: "restock",
      refundMethod: "store_credit",
    });
    assert.equal(refund.status, 200);
    assert.equal(Number(refund.json.refundTotal), 100);

    assert.equal(await creditBalance(), 100);
  });

  it("spends credit on a new sale (full settlement)", async () => {
    const res = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "store_credit", amount: 100 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 100, discount: null }],
    });
    assert.equal(res.status, 201);
    const saleId = (res.json as { data: { sale: { id: number } } }).data.sale.id;
    assert.equal(await creditBalance(), 0);

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const pay = await client.query(
      `SELECT payment_method FROM sale_payments WHERE sale_id = $1`,
      [saleId],
    );
    const sale = await client.query(
      `SELECT payment_status, due_amount FROM sales WHERE id = $1`,
      [saleId],
    );
    await client.end();
    assert.equal(pay.rows[0].payment_method, "store_credit");
    assert.equal(sale.rows[0].payment_status, "paid");
    assert.equal(Number(sale.rows[0].due_amount), 0);
  });

  it("spends credit partially and settles the rest as due", async () => {
    // Grant 60 more via another refund.
    const { saleItemId } = await createCashSale(100);
    const refund = await api("POST", `/api/sold_products/refund/${saleItemId}`, {
      reason: "customer_request",
      disposition: "restock",
      refundMethod: "store_credit",
    });
    assert.equal(refund.status, 200);
    const granted = Number(refund.json.refundTotal);

    const res = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [
        { method: "store_credit", amount: 40 },
        { method: "due", amount: granted - 40 },
      ],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: granted, discount: null }],
    });
    assert.equal(res.status, 201);
    const balance = await creditBalance();
    assert.equal(balance, granted - 40);
  });

  it("rejects a sale spending more credit than the balance", async () => {
    const balance = await creditBalance();
    // The server prices from the DB (100/line) — try to pay a full 100 line
    // with store_credit while the balance is lower than that.
    assert.ok(balance < 100, "fixture expects a balance below the line price");
    const res = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "store_credit", amount: 100 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 100, discount: null }],
    });
    assert.equal(res.status, 409);
    assert.match(res.json.message ?? "", /Insufficient store credit/);
    // The failed sale must not have touched the ledger.
    assert.equal(await creditBalance(), balance);
  });

  it("rejects store-credit payments without a customer", async () => {
    const res = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "store_credit", amount: 10 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 10, discount: null }],
    });
    assert.equal(res.status, 400);
    assert.match(res.json.message ?? "", /require a customer/);
  });

  it("keeps the ledger reconciled with the reported balance", async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const ledger = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS balance FROM customer_credits WHERE business_id = $1 AND customer_id = $2`,
      [businessId, customerId],
    );
    await client.end();
    assert.equal(Number(ledger.rows[0].balance), await creditBalance());
  });
});
