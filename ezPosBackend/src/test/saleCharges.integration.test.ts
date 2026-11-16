/**
 * P3 Phase 1 (F1): named sale-level charges — quote/checkout parity, header
 * persistence, receipt payload, refund pro-rata share, idempotent retry,
 * payload validation. Against a REAL PostgreSQL database. Double-guarded
 * like the other suites.
 *
 * Plain `npm test` NEVER runs this file.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("saleCharges integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let pg: import("pg").Client | null = null;

  before(async () => {
    const { default: pgDefault } = await import("pg");
    const client = new pgDefault.Client({
      connectionString: process.env.DATABASE_URL,
    });
    await client.connect();
    const db = await client.query("SELECT current_database() AS db");
    if (db.rows[0]?.db !== "ezpos_test") {
      await client.end();
      throw new Error(
        `SAFETY ABORT: connected to "${db.rows[0]?.db}" — integration tests may only run against ezpos_test.`,
      );
    }
    pg = client;
    await ensureRbacSeed();

    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server?.close();
    await pg?.end();
    pg = null;
  });

  interface Ctx {
    token: string;
    businessId: number;
    userId: number;
    email: string;
  }

  const stamp = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  let counter = 0;
  const uniqueEmail = () =>
    `chg-${Date.now()}-${(counter += 1)}@example.test`;

  async function api(
    ctx: Ctx,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.token}`,
        "X-Business-Id": String(ctx.businessId),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  async function dbQuery(sql: string, params: unknown[] = []): Promise<any[]> {
    const rows = await pg!.query(sql, params);
    return rows.rows;
  }

  function payload<T>(res: { body: unknown }): T {
    return (res.body as { data: T }).data;
  }

  let owner: Ctx;
  let variantId = 0;

  before(async () => {
    const ownerEmail = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Chg Owner",
        email: ownerEmail,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ownerEmail, password: "strong-password-123" }),
    });
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as {
      accessToken: string;
      user: { id: number };
    };
    owner = {
      token: loginBody.accessToken,
      businessId: 0,
      userId: loginBody.user.id,
      email: ownerEmail,
    };
    const biz = await api(owner, "POST", "/api/businesses", {
      name: `Charge Co ${stamp}`,
    });
    assert.equal(biz.status, 201);
    owner.businessId = biz.body.business.id;

    const locRes = await api(owner, "POST", "/api/locations", {
      name: `Charge Main ${stamp}`,
    });
    assert.equal(locRes.status, 201);
    const locationId = payload<{ id: number }>(locRes).id;
    void locationId;

    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Piece ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ value: number }>(unitRes).value;
    const product = await api(owner, "POST", "/api/product", {
      name: `Charge Cola ${stamp}`,
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
          sku: `CHG-${stamp}`,
          barcode: null,
          sellingPrice: 100,
          alertQuantity: 5,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `CHGB-${stamp}`,
          purchasePrice: 40,
          quantity: 500,
          expiryDate: null,
        },
      ],
    });
    assert.equal(product.status, 201);
    const list = await api(owner, "GET", "/api/products");
    const created = (
      list.body as { name: string; variants: { id: number }[] }[]
    ).find((p) => p.name === `Charge Cola ${stamp}`);
    assert.ok(created);
    variantId = created.variants[0]!.id;
  });

  function salePayload(overrides: Record<string, unknown> = {}) {
    return {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 250, tendered: 250 }],
      discount: null,
      vatPercent: 0,
      items: [
        {
          variantId,
          quantity: 2,
          unitPrice: 100,
          discount: null,
        },
      ],
      charges: [{ label: "Delivery", amount: 50 }],
      ...overrides,
    };
  }

  it("quotes and checks out identically with charges (post-VAT additive)", async () => {
    // Quote: 2 × 100 + 15% VAT + 50 charge = 230 + 50 = 280.
    const quote = await api(owner, "POST", "/api/sales/quote", {
      items: [{ variantId, quantity: 2, unitPrice: 100 }],
      cartDiscount: null,
      vatPercent: 15,
      charges: [{ label: "Delivery", amount: 50 }],
    });
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    const totals = payload<any>(quote);
    assert.equal(Number(totals.chargesTotal), 50);
    assert.equal(Number(totals.finalTotal), 280);
    assert.equal(totals.charges?.[0]?.label, "Delivery");

    // Checkout with the same cart → the SAME final total (quote == checkout).
    const sale = await api(owner, "POST", "/api/sales", salePayload({
      payments: [{ method: "cash", amount: 280, tendered: 280 }],
      vatPercent: 15,
    }));
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const saleId = sale.body.data.sale.id as number;
    assert.equal(Number(sale.body.data.sale.finalTotal), 280);

    const chargeRows = await dbQuery(
      "SELECT label, amount, sort_order FROM sale_charges WHERE sale_id = $1 ORDER BY sort_order",
      [saleId],
    );
    assert.equal(chargeRows.length, 1);
    assert.equal(chargeRows[0]!.label, "Delivery");
    assert.equal(Number(chargeRows[0]!.amount), 50);

    // Charges are NOT fake sale items — product profitability stays clean.
    const itemRows = await dbQuery(
      "SELECT count(*)::int AS n FROM sale_items WHERE sale_id = $1",
      [saleId],
    );
    assert.equal(itemRows[0]!.n, 1);
  });

  it("rejects invalid charge payloads (negative amount, empty label)", async () => {
    const bad = await api(owner, "POST", "/api/sales", salePayload({
      charges: [{ label: "Delivery", amount: -5 }],
      payments: [{ method: "cash", amount: 245 }],
    }));
    assert.equal(bad.status, 400);

    const badLabel = await api(owner, "POST", "/api/sales", salePayload({
      charges: [{ label: "   ", amount: 5 }],
      payments: [{ method: "cash", amount: 255 }],
    }));
    assert.equal(badLabel.status, 400);
  });

  it("charges are coupon-immune: the coupon reduces the product portion only", async () => {
    // Without a coupon the total is 250; the coupon evaluation lives behind
    // coupon creation — the invariant checked here is that charges survive
    // a discount on the product portion via the quote endpoint math.
    const quote = await api(owner, "POST", "/api/sales/quote", {
      items: [{ variantId, quantity: 2, unitPrice: 100 }],
      cartDiscount: { type: "fixed", value: 40 },
      vatPercent: 0,
      charges: [{ label: "Service", amount: 30 }],
    });
    assert.equal(quote.status, 200);
    const totals = payload<any>(quote);
    // 200 − 40 discount = 160, + 0 VAT, + 30 charge — the charge is NOT
    // discounted.
    assert.equal(Number(totals.finalTotal), 190);
    assert.equal(Number(totals.chargesTotal), 30);
  });

  it("receipt payload carries the named charges", async () => {
    const sale = await api(owner, "POST", "/api/sales", salePayload({
      idempotencyKey: `chg-receipt-${stamp}`,
    }));
    assert.equal(sale.status, 201);
    const saleId = sale.body.data.sale.id as number;
    const receipt = await api(owner, "GET", `/api/sales/${saleId}/receipt`);
    assert.equal(receipt.status, 200);
    // The receipt endpoint returns the payload unwrapped (no {data} envelope).
    const data = receipt.body;
    assert.ok(Array.isArray(data.charges));
    assert.equal(data.charges.length, 1);
    assert.equal(data.charges[0].label, "Delivery");
    assert.equal(Number(data.chargesTotal), 50);
  });

  it("an idempotent retry does not duplicate charge rows", async () => {
    const key = `chg-idem-${stamp}`;
    const first = await api(owner, "POST", "/api/sales", salePayload({ idempotencyKey: key }));
    assert.equal(first.status, 201);
    const second = await api(owner, "POST", "/api/sales", salePayload({ idempotencyKey: key }));
    assert.equal(second.status, 201);
    assert.equal(second.body.data.sale.id, first.body.data.sale.id);
    const rows = await dbQuery(
      "SELECT count(*)::int AS n FROM sale_charges WHERE sale_id = $1",
      [first.body.data.sale.id],
    );
    assert.equal(rows[0]!.n, 1);
    const sales = await dbQuery(
      "SELECT count(*)::int AS n FROM sales WHERE idempotency_key = $1",
      [key],
    );
    assert.equal(sales[0]!.n, 1);
  });

  it("a full refund refunds the charge share via the header delta", async () => {
    const sale = await api(owner, "POST", "/api/sales", salePayload());
    assert.equal(sale.status, 201);
    const saleId = sale.body.data.sale.id as number;
    const refund = await api(
      owner,
      "POST",
      `/api/sold_products/refunds_all/${saleId}`,
      { reason: "customer_request", disposition: "restock", refundMethod: "cash" },
    );
    assert.equal(refund.status, 200, JSON.stringify(refund.body));
    const refundRows = await dbQuery(
      "SELECT refund_total FROM sale_refunds WHERE sale_id = $1",
      [saleId],
    );
    // 200 product + 50 charge = 250 — the header delta carries the charge.
    assert.equal(Number(refundRows[0]!.refund_total), 250);
  });
});
