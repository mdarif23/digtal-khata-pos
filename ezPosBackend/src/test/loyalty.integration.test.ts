/**
 * Loyalty program integration tests (Module 7): earn on paid sales, redeem
 * at checkout (locked ledger, no overdraft), refund clawback, and config
 * gating (no program → nothing earns, points rejected as payment).
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("loyalty program integration", { skip: !runIntegration }, () => {
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
    `loyalty-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

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

  async function saleWith(payments: unknown, price = 100) {
    return api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments,
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: price, discount: null }],
    });
  }

  async function balance(): Promise<number> {
    const res = await api("GET", `/api/customers/${customerId}/loyalty`);
    assert.equal(res.status, 200);
    return Number((res.json as { data: { balance: number } }).data.balance);
  }

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Loyalty Test", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Loyalty Biz ${Date.now()}` }),
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
      name: "Loyalty Customer",
      phone: "1711000014",
    });
    customerId = cust.json.id;
    const prodRes = await api("POST", "/api/product", {
      name: "Loyalty Product",
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
      (p) => p.name === "Loyalty Product",
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    variantId = (detail.json as { variants: { id: number }[] }).variants[0]!.id;
  });

  it("with no program configured, nothing earns and points payment is rejected", async () => {
    const program = await api("GET", "/api/loyalty/program");
    assert.equal(program.status, 200);
    assert.equal(program.json.data, null);

    const sale = await saleWith([{ method: "cash", amount: 100, tendered: 100 }]);
    assert.equal(sale.status, 201);
    assert.equal(await balance(), 0);

    const redeem = await saleWith([
      { method: "loyalty_points", amount: 10 },
      { method: "due", amount: 90 },
    ]);
    // No program → redemption unavailable (400), and no points to spend
    // anyway (409) — either rejection is honest.
    assert.ok([400, 409].includes(redeem.status));
  });

  it("configures the program (earn 0.01/৳ → 1pt per ৳100; 1pt = ৳1 redeem)", async () => {
    const put = await api("PUT", "/api/loyalty/program", {
      earnRate: 0.01,
      redeemValue: 1,
      isActive: true,
    });
    assert.equal(put.status, 200);
    const program = await api("GET", "/api/loyalty/program");
    assert.equal(program.json.data.isActive, true);
  });

  it("earns points on a paid sale (dues earn nothing)", async () => {
    const paid = await saleWith([{ method: "cash", amount: 100, tendered: 100 }]);
    assert.equal(paid.status, 201);
    assert.equal(await balance(), 1); // 100 × 0.01

    const due = await saleWith([{ method: "due", amount: 100 }]);
    assert.equal(due.status, 201);
    assert.equal(await balance(), 1); // dues earn nothing
  });

  it("redeems points at checkout; overdraft is refused", async () => {
    // 1 point = ৳1 → pay a 100 sale with 1 point? Not enough — sell with
    // 0.5 point? points are 2dp: redeem 1 point for ৳1 of a ৳100 sale.
    const redeem = await saleWith([
      { method: "loyalty_points", amount: 1 },
      { method: "cash", amount: 99, tendered: 99 },
    ]);
    assert.equal(redeem.status, 201);
    // −1 redeemed, +0.99 earned on the ৳99 cash portion of the same sale.
    assert.equal(await balance(), 0.99);

    const overdraft = await saleWith([
      { method: "loyalty_points", amount: 5 },
      { method: "due", amount: 95 },
    ]);
    assert.equal(overdraft.status, 409);
    assert.match(overdraft.json.message ?? "", /Insufficient loyalty points/);
    // The failed sale must not have touched the ledger.
    assert.equal(await balance(), 0.99);
  });

  it("reverses earned points when a sale is refunded", async () => {
    // Earn 1 point (100 paid), then refund the sale fully → clawback.
    const sale = await saleWith([{ method: "cash", amount: 100, tendered: 100 }]);
    assert.equal(sale.status, 201);
    assert.equal(await balance(), 1.99); // 0.99 + 1 earned

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const item = await client.query(
      `SELECT id FROM sale_items WHERE sale_id = $1 LIMIT 1`,
      [(sale.json as { data: { sale: { id: number } } }).data.sale.id],
    );
    await client.end();

    const refund = await api(
      "POST",
      `/api/sold_products/refund/${item.rows[0].id}`,
      { reason: "customer_request", disposition: "restock" },
    );
    assert.equal(refund.status, 200);
    assert.equal(await balance(), 0.99); // 1.99 − 1 clawback (the redeem sale's earn stays)
  });

  it("refund clawback consumes the earn batch — the expiry sweep cannot double-penalize", async () => {
    // E1-005: the reversal used to write ONLY a ledger row, leaving the
    // earn batch full — the daily sweep then expired the same points again
    // (earn 100 → refund −100 → sweep −100 → balance −100).
    const sale = await saleWith([{ method: "cash", amount: 100, tendered: 100 }]);
    assert.equal(sale.status, 201);
    const balanceAfterEarn = await balance();

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const saleId = (sale.json as { data: { sale: { id: number } } }).data.sale.id;
    const item = await client.query(
      `SELECT id FROM sale_items WHERE sale_id = $1 LIMIT 1`,
      [saleId],
    );
    await client.end();

    const refund = await api("POST", `/api/sold_products/refund/${item.rows[0].id}`, {
      reason: "customer_request",
      disposition: "restock",
    });
    assert.equal(refund.status, 200);
    assert.equal(await balance(), balanceAfterEarn - 1); // full clawback

    // The clawback consumed the earn batches FIFO (oldest expiring first) —
    // the core invariant: Σ batches == Σ ledger. Before the fix the reversal
    // wrote ONLY a ledger row, leaving 1 extra batch point for the sweep to
    // expire AGAIN (balance went negative on earn→refund→expire).
    {
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      const batches = await client.query(
        `SELECT COALESCE(SUM(points_remaining), 0) AS total FROM loyalty_points_batches
         WHERE business_id = $1 AND customer_id = $2`,
        [businessId, customerId],
      );
      await client.end();
      assert.equal(Number(batches.rows[0].total), balanceAfterEarn - 1);
    }

    // Force every batch of this customer expired, then sweep: the sweep may
    // only expire points still HELD (batch-backed), never points already
    // clawed back.
    {
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      await client.query(
        `UPDATE loyalty_points_batches SET expires_at = now() - interval '1 day'
         WHERE business_id = $1 AND customer_id = $2`,
        [businessId, customerId],
      );
      await client.end();
    }
    const { runLoyaltyExpirySweep } = await import("../services/loyalty.js");
    await runLoyaltyExpirySweep(businessId);

    const balanceAfterSweep = await balance();
    assert.ok(
      balanceAfterSweep >= 0,
      `sweep must never drive a refunded balance negative (got ${balanceAfterSweep})`,
    );

    // Core invariant after the sweep: batch sum must equal the ledger balance.
    {
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      const batches = await client.query(
        `SELECT COALESCE(SUM(points_remaining), 0) AS total FROM loyalty_points_batches
         WHERE business_id = $1 AND customer_id = $2`,
        [businessId, customerId],
      );
      await client.end();
      assert.equal(Number(batches.rows[0].total), balanceAfterSweep);
    }
  });

  it("keeps the ledger reconciled with the reported balance", async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const ledger = await client.query(
      `SELECT COALESCE(SUM(points), 0) AS balance FROM loyalty_ledger WHERE business_id = $1 AND customer_id = $2`,
      [businessId, customerId],
    );
    await client.end();
    assert.equal(Number(ledger.rows[0].balance), await balance());
  });
});
