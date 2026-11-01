/**
 * Sale payment intent integration tests — the electronic payment layer
 * (Phase 1 payment architecture). Exercises the full
 * intent → gateway → server-side verify → sale_payments row flow against
 * the REAL database and the REAL HTTP app, with the mock provider's
 * deterministic val_id contract (MOCK-VALID-<amount>).
 *
 * Double-guarded like every integration suite: INTEGRATION_TESTS=1 AND
 * DATABASE_URL pointing at ezpos_test. Plain `npm test` never runs this.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("sale payment intents integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";

  before(async () => {
    // Fail closed: refuse to write to anything but ezpos_test.
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

    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(() => {
    server?.close();
  });

  const uniqueEmail = () =>
    `saleintent-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;
  const uniqueKey = (tag: string) =>
    `itest-${tag}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

  let token = "";
  let businessId = 0;
  let otherToken = "";
  let otherBusinessId = 0;

  async function api(
    token: string | null,
    bizId: number | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    if (bizId !== null) headers["X-Business-Id"] = String(bizId);
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) {
      console.error(
        `API ${method} ${path} -> ${res.status}:`,
        JSON.stringify(await res.clone().json().catch(() => null)),
      );
    }
    return res;
  }

  async function registerAndCreateBusiness(
    email: string,
    businessName: string,
  ): Promise<{ token: string; businessId: number }> {
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Intent Test", email, password: "strong-password-123" }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as { accessToken: string };
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginBody.accessToken}`,
      },
      body: JSON.stringify({ name: businessName }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business: { id: number } };

    // Every business fixture gets a default location: location-scoped
    // endpoints refuse to operate otherwise (same as the other suites).
    const loc = await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginBody.accessToken}`,
        "X-Business-Id": String(bizBody.business.id),
      },
      body: JSON.stringify({ name: "Main Store" }),
    });
    assert.equal(loc.status, 201);

    return { token: loginBody.accessToken, businessId: bizBody.business.id };
  }

  /** Creates a fully-credit sale of `price` (due = price) and returns its id. */
  async function createDueSale(
    tok: string,
    bizId: number,
    productName: string,
    price: number,
  ): Promise<number> {
    const unitRes = await api(tok, bizId, "POST", "/api/product/unit", {
      unitName: "Piece",
      abbreviation: "Pcs",
    });
    assert.equal(unitRes.status, 201);
    const unitId = ((await unitRes.json()) as { data: { value: number } }).data.value;

    const prodRes = await api(tok, bizId, "POST", "/api/product", {
      name: productName,
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
          sellingPrice: price,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: Math.round(price / 2),
          quantity: 5,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prodRes.status, 201);
    const listRes = await api(tok, bizId, "GET", "/api/products");
    const list = (await listRes.json()) as { id: number; name: string }[];
    const productId = list.find((p) => p.name === productName)!.id;
    const prodRes2 = await api(tok, bizId, "GET", `/api/product/${productId}`);
    const variantId = ((await prodRes2.json()) as { variants: { id: number }[] })
      .variants[0]!.id;

    // Due payments require a customer (receivables must attach somewhere).
    const custRes = await api(tok, bizId, "POST", "/api/customers", {
      name: `Intent Customer ${Date.now()}`,
      phone: "1711000000",
    });
    assert.equal(custRes.status, 201);
    const customerId = (await custRes.json()) as { id: number };

    const saleRes = await api(tok, bizId, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: customerId.id,
      payments: [{ method: "due", amount: price }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: price, discount: null }],
    });
    assert.equal(saleRes.status, 201);
    return ((await saleRes.json()) as { data: { sale: { id: number } } }).data.sale.id;
  }

  function intentBody(amount: number, key: string) {
    return {
      provider: "mock",
      method: "bangla_qr",
      amount,
      idempotencyKey: key,
      redirectUrls: {
        success: "http://localhost:5173/payment/success",
        fail: "http://localhost:5173/payment/failed",
        cancel: "http://localhost:5173/payment/canceled",
      },
    };
  }

  async function saleRow(saleId: number) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const res = await client.query(
      `SELECT due_amount, payment_status FROM sales WHERE id = $1`,
      [saleId],
    );
    await client.end();
    assert.equal(res.rows.length, 1);
    return res.rows[0] as { due_amount: string; payment_status: string };
  }

  async function intentRow(intentId: number) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const res = await client.query(
      `SELECT status, provider_txn_id, captured_sale_payment_id FROM sale_payment_intents WHERE id = $1`,
      [intentId],
    );
    await client.end();
    assert.equal(res.rows.length, 1);
    return res.rows[0] as {
      status: string;
      provider_txn_id: string | null;
      captured_sale_payment_id: number | null;
    };
  }

  async function createIntent(
    tok: string,
    bizId: number,
    saleId: number,
    amount: number,
    key: string,
  ): Promise<{ status: number; intentId: number; gatewayUrl: string | null; replayed: boolean }> {
    const res = await api(tok, bizId, "POST", `/api/sales/${saleId}/payment-intents`, intentBody(amount, key));
    const body = (await res.json()) as {
      data?: { intentId: number; gatewayUrl: string | null; replayed: boolean };
      message?: string;
    };
    if (res.status !== 201 && res.status !== 200) {
      console.error("createIntent failed:", res.status, JSON.stringify(body));
    }
    return {
      status: res.status,
      intentId: body.data?.intentId ?? 0,
      gatewayUrl: body.data?.gatewayUrl ?? null,
      replayed: body.data?.replayed ?? false,
    };
  }

  async function verifyIntent(
    tok: string,
    bizId: number,
    intentId: number,
    valId: string,
  ): Promise<{ status: number; verified: boolean; alreadyCaptured: boolean; reason?: string }> {
    const res = await api(tok, bizId, "POST", `/api/sales/payment-intents/${intentId}/verify`, { valId });
    const body = (await res.json()) as {
      success: boolean;
      data?: { verified: boolean; alreadyCaptured: boolean; reason?: string };
    };
    return {
      status: res.status,
      verified: body.data?.verified ?? false,
      alreadyCaptured: body.data?.alreadyCaptured ?? false,
      ...(body.data?.reason !== undefined ? { reason: body.data.reason } : {}),
    };
  }

  it("creates an intent, verifies server-side, and captures against the sale", async () => {
    const a = await registerAndCreateBusiness(uniqueEmail(), `Intent A ${Date.now()}`);
    token = a.token;
    businessId = a.businessId;
    const saleId = await createDueSale(token, businessId, "Intent Product A", 200);

    const created = await createIntent(token, businessId, saleId, 150, uniqueKey("capture"));
    assert.equal(created.status, 201);
    assert.ok(created.intentId > 0);
    assert.match(created.gatewayUrl!, /payment\/success/);
    assert.equal(created.replayed, false);

    const verified = await verifyIntent(
      token,
      businessId,
      created.intentId,
      "MOCK-VALID-150",
    );
    assert.equal(verified.status, 200);
    assert.equal(verified.verified, true);
    assert.equal(verified.alreadyCaptured, false);

    const sale = await saleRow(saleId);
    assert.equal(Number(sale.due_amount), 50);
    assert.equal(sale.payment_status, "partial");
    const intent = await intentRow(created.intentId);
    assert.equal(intent.status, "captured");
    assert.equal(intent.provider_txn_id, "MOCK-VALID-150");
    assert.ok(intent.captured_sale_payment_id);
  });

  it("replays the same intent for a repeated idempotency key (no second charge)", async () => {
    const saleId = await createDueSale(token, businessId, "Intent Product B", 100);
    const key = uniqueKey("replay");

    const first = await createIntent(token, businessId, saleId, 100, key);
    assert.equal(first.status, 201);

    const second = await createIntent(token, businessId, saleId, 100, key);
    assert.equal(second.status, 200); // replay → 200, not a new 201
    assert.equal(second.intentId, first.intentId);
    assert.equal(second.replayed, true);
  });

  it("double verification captures exactly once", async () => {
    const saleId = await createDueSale(token, businessId, "Intent Product C", 60);
    const created = await createIntent(token, businessId, saleId, 60, uniqueKey("dup"));
    assert.equal(created.status, 201);

    const first = await verifyIntent(token, businessId, created.intentId, "MOCK-VALID-60");
    assert.equal(first.verified, true);
    assert.equal(first.alreadyCaptured, false);

    const second = await verifyIntent(token, businessId, created.intentId, "MOCK-VALID-60");
    assert.equal(second.status, 200);
    assert.equal(second.verified, true);
    assert.equal(second.alreadyCaptured, true);

    const sale = await saleRow(saleId);
    assert.equal(Number(sale.due_amount), 0);
    assert.equal(sale.payment_status, "paid");
  });

  it("rejects amounts exceeding the outstanding due", async () => {
    const saleId = await createDueSale(token, businessId, "Intent Product D", 100);
    const res = await api(
      token,
      businessId,
      "POST",
      `/api/sales/${saleId}/payment-intents`,
      intentBody(300, uniqueKey("over")),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { message?: string };
    assert.match(body.message ?? "", /exceeds the outstanding due/);
  });

  it("fails the intent and leaves the sale untouched when the gateway invalidates", async () => {
    const saleId = await createDueSale(token, businessId, "Intent Product E", 80);
    const created = await createIntent(token, businessId, saleId, 80, uniqueKey("invalid"));
    assert.equal(created.status, 201);

    const verified = await verifyIntent(
      token,
      businessId,
      created.intentId,
      "NOT-A-VALID-VAL-ID",
    );
    assert.equal(verified.status, 409);
    assert.equal(verified.verified, false);

    const sale = await saleRow(saleId);
    assert.equal(Number(sale.due_amount), 80); // unchanged
    const intent = await intentRow(created.intentId);
    assert.equal(intent.status, "failed");
  });

  it("another business cannot verify or cancel a foreign intent (404, not 403)", async () => {
    const saleId = await createDueSale(token, businessId, "Intent Product F", 40);
    const created = await createIntent(token, businessId, saleId, 40, uniqueKey("foreign"));

    const b = await registerAndCreateBusiness(uniqueEmail(), `Intent Foreign ${Date.now()}`);
    const verifyRes = await api(
      b.token,
      b.businessId,
      "POST",
      `/api/sales/payment-intents/${created.intentId}/verify`,
      { valId: "MOCK-VALID-40" },
    );
    assert.equal(verifyRes.status, 404);
    const cancelRes = await api(
      b.token,
      b.businessId,
      "POST",
      `/api/sales/payment-intents/${created.intentId}/cancel`,
      {},
    );
    assert.equal(cancelRes.status, 404);
  });

  it("cancels a pending intent; a captured intent refuses cancellation", async () => {
    const saleId = await createDueSale(token, businessId, "Intent Product G", 30);
    const pending = await createIntent(token, businessId, saleId, 30, uniqueKey("cancel"));
    const cancelRes = await api(
      token,
      businessId,
      "POST",
      `/api/sales/payment-intents/${pending.intentId}/cancel`,
      {},
    );
    assert.equal(cancelRes.status, 200);
    assert.equal((await intentRow(pending.intentId)).status, "cancelled");

    // Captured intents are immutable.
    const capture = await createIntent(token, businessId, saleId, 30, uniqueKey("cancel2"));
    await verifyIntent(token, businessId, capture.intentId, "MOCK-VALID-30");
    const cancelCaptured = await api(
      token,
      businessId,
      "POST",
      `/api/sales/payment-intents/${capture.intentId}/cancel`,
      {},
    );
    assert.equal(cancelCaptured.status, 409);
  });

  it("IPN (unauthenticated) captures by tran_id lookup without a user session", async () => {
    const saleId = await createDueSale(token, businessId, "Intent Product H", 25);
    const key = uniqueKey("ipn");
    const created = await createIntent(token, businessId, saleId, 25, key);
    assert.equal(created.status, 201);

    // Gateways POST form-urlencoded; no Authorization header at all.
    const ipnRes = await fetch(`${baseUrl}/api/sales/payment-intents/ipn`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tran_id: key, val_id: "MOCK-VALID-25" }).toString(),
    });
    assert.equal(ipnRes.status, 200);

    const sale = await saleRow(saleId);
    assert.equal(Number(sale.due_amount), 0);
    assert.equal(sale.payment_status, "paid");
    const intent = await intentRow(created.intentId);
    assert.equal(intent.status, "captured");
  });

  it("an unknown tran_id in the IPN does not error the gateway", async () => {
    const ipnRes = await fetch(`${baseUrl}/api/sales/payment-intents/ipn`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        tran_id: "no-such-tran-id",
        val_id: "MOCK-VALID-1",
      }).toString(),
    });
    assert.equal(ipnRes.status, 200); // answered, state unchanged
  });
});
