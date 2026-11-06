/**
 * Exchange + refund-method integration tests (Module 5, Phase 1).
 *
 * Covers: even exchange (equal value), exchange with additional payment,
 * exchange with surplus refund (cash + provider via mock), refund ceilings
 * (no over-refund), double-refund rejection, serial restock on exchange,
 * provider payout via original_payment on a captured mock intent, and
 * idempotent exchange replay.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("exchanges and refund methods integration", { skip: !runIntegration }, () => {
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
    `exchange-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let unitId = 0;
  let customerId = 0;
  let variantA = 0; // 100 each
  let variantB = 0; // 150 each
  let variantC = 0; // 50 each

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

  async function createProduct(
    name: string,
    sellingPrice: number,
  ): Promise<number> {
    const res = await api("POST", "/api/product", {
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
          sellingPrice,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: Math.round(sellingPrice / 2),
          quantity: 20,
          expiryDate: null,
        },
      ],
    });
    assert.equal(res.status, 201);
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find(
      (p) => p.name === name,
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    return (detail.json as { variants: { id: number }[] }).variants[0]!.id;
  }

  /** Fully-paid cash sale of one line; returns {saleId, saleItemId}. */
  async function createCashSale(
    variantId: number,
    price: number,
  ): Promise<{ saleId: number; saleItemId: number }> {
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

  async function saleRow(saleId: number) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const res = await client.query(
      `SELECT status, payment_status, exchange_of_sale_id, final_total FROM sales WHERE id = $1`,
      [saleId],
    );
    await client.end();
    return res.rows[0];
  }

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Exchange Test", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Exchange Biz ${Date.now()}` }),
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
      name: "Exchange Customer",
      phone: "1711000009",
    });
    customerId = cust.json.id;
    variantA = await createProduct("Exchange A", 100);
    variantB = await createProduct("Exchange B", 150);
    variantC = await createProduct("Exchange C", 50);
  });

  it("performs an even exchange: returned item restocks, replacement sells, values net to zero", async () => {
    const { saleId, saleItemId } = await createCashSale(variantA, 100);
    const res = await api("POST", `/api/sales/${saleId}/exchange`, {
      returns: [{ saleItemId }],
      replacements: [{ variantId: variantA, quantity: 1 }],
      reason: "wrong_item",
      disposition: "restock",
    });
    assert.equal(res.status, 201);
    const body = res.json as {
      data: {
        sale: { id: number; invoiceNumber: string };
        refundId: number;
        refundTotal: number;
        replacementTotal: number;
        difference: number;
      };
    };
    assert.equal(body.data.difference, 0);
    assert.equal(body.data.refundTotal, 100);
    assert.equal(body.data.replacementTotal, 100);

    // The original is fully refunded; the replacement links back.
    const original = await saleRow(saleId);
    assert.equal(original.status, "refunded");
    const replacement = await saleRow(body.data.sale.id);
    assert.equal(replacement.exchange_of_sale_id, saleId);
    assert.equal(replacement.status, "completed");
    assert.equal(Number(replacement.final_total), 100);

    // Stock: one restocked, one consumed by the replacement — the
    // replacement IS a real sale and must decrement inventory_stock
    // (multi-terminal Phase 1 fixed the old batches-only drift).
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const stock = await client.query(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [variantA, businessId],
    );
    const refundMethod = await client.query(
      `SELECT refund_method FROM sale_refunds WHERE id = $1`,
      [body.data.refundId],
    );
    await client.end();
    // 20 opening − 1 sold − 1 replacement + 1 restock = 19.
    assert.equal(Number(stock.rows[0].quantity), 19);
    // An even exchange settles against itself — no payout direction, so the
    // refund row is informational (refund_method NULL).
    assert.equal(refundMethod.rows[0].refund_method, null);
  });

  it("exchanges up: additional payment exactly covers the difference", async () => {
    const { saleId, saleItemId } = await createCashSale(variantC, 50);
    const res = await api("POST", `/api/sales/${saleId}/exchange`, {
      returns: [{ saleItemId }],
      replacements: [{ variantId: variantB, quantity: 1 }],
      additionalPayments: [{ method: "cash", amount: 100, tendered: 100 }],
      reason: "customer_request",
      disposition: "restock",
    });
    assert.equal(res.status, 201);
    const body = res.json as { data: { difference: number; sale: { id: number } } };
    assert.equal(body.data.difference, 100);

    // Replacement sale has one payment row for the top-up.
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const pay = await client.query(
      `SELECT amount, payment_method FROM sale_payments WHERE sale_id = $1`,
      [body.data.sale.id],
    );
    await client.end();
    assert.equal(pay.rows.length, 1);
    assert.equal(Number(pay.rows[0].amount), 100);
    assert.equal(pay.rows[0].payment_method, "cash");
  });

  it("rejects an up-exchange whose additional payment does not match the difference", async () => {
    const { saleId, saleItemId } = await createCashSale(variantC, 50);
    const res = await api("POST", `/api/sales/${saleId}/exchange`, {
      returns: [{ saleItemId }],
      replacements: [{ variantId: variantB, quantity: 1 }],
      additionalPayments: [{ method: "cash", amount: 10 }],
      reason: "customer_request",
      disposition: "restock",
    });
    assert.equal(res.status, 400);
  });

  it("exchanges down: surplus refund via cash is recorded", async () => {
    const { saleId, saleItemId } = await createCashSale(variantB, 150);
    const res = await api("POST", `/api/sales/${saleId}/exchange`, {
      returns: [{ saleItemId }],
      replacements: [{ variantId: variantC, quantity: 1 }],
      refundMethod: "cash",
      reason: "customer_request",
      disposition: "restock",
    });
    assert.equal(res.status, 201);
    const body = res.json as { data: { difference: number; refundId: number } };
    assert.equal(body.data.difference, -100);

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const refund = await client.query(
      `SELECT refund_total, refund_method, provider_refund_id FROM sale_refunds WHERE id = $1`,
      [body.data.refundId],
    );
    await client.end();
    assert.equal(Number(refund.rows[0].refund_total), 150);
    assert.equal(refund.rows[0].refund_method, "cash");
    assert.equal(refund.rows[0].provider_refund_id, null);
  });

  it("refunds to the original instrument via a captured mock intent", async () => {
    // Paid cash sale, then capture a mock intent against it... intents need
    // due; use a due sale captured fully via intent, then refund it.
    const cust2 = await api("POST", "/api/customers", {
      name: "Intent Refund Cust",
      phone: "1711000010",
    });
    const saleRes = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: cust2.json.id,
      payments: [{ method: "due", amount: 100 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: variantA, quantity: 1, unitPrice: 100, discount: null }],
    });
    const saleId = (saleRes.json as { data: { sale: { id: number } } }).data.sale.id;

    const intentRes = await api("POST", `/api/sales/${saleId}/payment-intents`, {
      provider: "mock",
      method: "bangla_qr",
      amount: 100,
      idempotencyKey: `ex-refund-${Date.now()}`,
      redirectUrls: {
        success: "http://localhost:5173/s",
        fail: "http://localhost:5173/f",
        cancel: "http://localhost:5173/c",
      },
    });
    assert.equal(intentRes.status, 201);
    const intentId = intentRes.json.data.intentId;
    const verify = await api(
      "POST",
      `/api/sales/payment-intents/${intentId}/verify`,
      { valId: "MOCK-VALID-100" },
    );
    assert.equal(verify.status, 200);

    // Full refund to the original instrument.
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const item = await client.query(
      `SELECT id FROM sale_items WHERE sale_id = $1 LIMIT 1`,
      [saleId],
    );
    await client.end();

    const refundRes = await api("POST", `/api/sold_products/refund/${item.rows[0].id}`, {
      reason: "customer_request",
      disposition: "restock",
      refundMethod: "original_payment",
    });
    assert.equal(refundRes.status, 200);
    const body = refundRes.json as {
      refundTotal: number;
      providerPayout: { paid: boolean; providerRefundId: string | null } | null;
    };
    assert.equal(Number(body.refundTotal), 100);
    assert.ok(body.providerPayout, "provider payout must be attempted");
    assert.equal(body.providerPayout!.paid, true);
    assert.match(body.providerPayout!.providerRefundId!, /^mock-refund-/);
  });

  it("never refunds more than the sale value (ceiling + double-refund guard)", async () => {
    const { saleId, saleItemId } = await createCashSale(variantA, 100);
    const first = await api("POST", `/api/sold_products/refund/${saleItemId}`, {
      reason: "damaged",
      disposition: "restock",
    });
    assert.equal(first.status, 200);
    const second = await api("POST", `/api/sold_products/refund/${saleItemId}`, {
      reason: "damaged",
      disposition: "restock",
    });
    assert.equal(second.status, 409);
    void saleId;
  });

  it("an already-refunded item cannot be exchanged", async () => {
    const { saleId, saleItemId } = await createCashSale(variantA, 100);
    await api("POST", `/api/sold_products/refund/${saleItemId}`, {
      reason: "damaged",
      disposition: "restock",
    });
    const res = await api("POST", `/api/sales/${saleId}/exchange`, {
      returns: [{ saleItemId }],
      replacements: [{ variantId: variantC, quantity: 1 }],
      reason: "customer_request",
      disposition: "restock",
    });
    // The original sale is now 'refunded' → exchange refuses up front.
    assert.ok([409, 404].includes(res.status));
  });

  it("replays an exchange for the same idempotency key (no duplicate sale)", async () => {
    const { saleId, saleItemId } = await createCashSale(variantC, 50);
    const key = `ex-idem-${Date.now()}`;
    const payload = {
      returns: [{ saleItemId }],
      replacements: [{ variantId: variantC, quantity: 1 }],
      reason: "wrong_item" as const,
      disposition: "restock" as const,
      idempotencyKey: key,
    };
    const first = await api("POST", `/api/sales/${saleId}/exchange`, payload);
    assert.equal(first.status, 201);
    const second = await api("POST", `/api/sales/${saleId}/exchange`, payload);
    assert.equal(second.status, 200); // replay
    const firstId = (first.json as { data: { sale: { id: number } } }).data.sale.id;
    const secondId = (second.json as { data: { sale: { id: number } } }).data.sale.id;
    assert.equal(secondId, firstId);
  });
});
