/**
 * Cash management integration tests (drawer ledger phase).
 *
 * Covers the drawer-side financial rules added on top of the register
 * sessions: counter cash refunds decrease the refunding drawer,
 * original_payment/store_credit refunds never touch drawer cash, exchange
 * surplus payouts vs collected differences are modeled as physical cash,
 * safe deposit/withdrawal and adjustment movements, cash due collections
 * entering the collector's drawer, and DB-level idempotency of
 * source-attributed movements.
 *
 * Double-guarded like the other suites: runs ONLY with INTEGRATION_TESTS=1
 * AND DATABASE_URL pointing at ezpos_test (fail-closed). Plain `npm test`
 * NEVER runs this file.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("cash management integration", { skip: !runIntegration }, () => {
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
    await ensureRbacSeed();
    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(() => {
    server?.close();
  });

  const stamp = Date.now();
  interface Ctx {
    token: string;
    businessId: number;
    userId: number;
  }

  async function api(
    ctx: Ctx,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.token}`,
        "X-Business-Id": String(ctx.businessId),
        ...extraHeaders,
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

  function payload<T>(res: { body: unknown }): T {
    return res.body as T;
  }

  let owner: Ctx;
  let registerMain = 0;
  let variantExpensive = 0;
  let variantCheap = 0;

  before(async () => {
    // Owner + business. The POST /api/businesses default location is the
    // one the location middleware resolves when no X-Location-Id is sent.
    const email = `cash-mgmt-${stamp}@example.test`;
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Cash Mgmt Owner",
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
    const loginText = await login.text();
    assert.equal(login.status, 200, loginText);
    const loginBody = JSON.parse(loginText) as {
      accessToken: string;
      user: { id: number };
    };
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginBody.accessToken}`,
      },
      body: JSON.stringify({ name: `Cash Mgmt Biz ${stamp}` }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business: { id: number } };
    owner = {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
    };

    // The default location — inventory and sales resolve here when no
    // X-Location-Id header is sent.
    const location = await api(owner, "POST", "/api/locations", {
      name: `Cash Mgmt Store ${stamp}`,
    });
    assert.equal(location.status, 201);

    // A stocked product with two price points for exchange math.
    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Piece ${stamp}`,
      abbreviation: "Pcs",
    });
    assert.equal(unitRes.status, 201, JSON.stringify(unitRes.body));
    const unitId = payload<{ data: { value: number } }>(unitRes).data.value;

    /** One stocked single-variant product at the given price. */
    async function createProduct(
      name: string,
      price: number,
      cost: number,
    ): Promise<number> {
      const res = await api(owner, "POST", "/api/product", {
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
            sku: `CM-${price}-${stamp}`,
            barcode: null,
            sellingPrice: price,
            alertQuantity: 5,
            isDefault: true,
            status: "active",
            imageUrl: null,
            imageFile: null,
            batchNumber: `CM-B-${price}-${stamp}`,
            purchasePrice: cost,
            quantity: 500,
            expiryDate: null,
          },
        ],
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const list = await api(owner, "GET", "/api/products");
      const created = (
        list.body as { name: string; variants: { id: number }[] }[]
      ).find((p) => p.name === name);
      assert.ok(created, `product ${name} not found after creation`);
      return created.variants[0]!.id;
    }

    variantExpensive = await createProduct(`Cash Mgmt Cola ${stamp}`, 100, 40);
    variantCheap = await createProduct(`Cash Mgmt Water ${stamp}`, 60, 24);

    const registerRes = await api(owner, "POST", "/api/registers", {
      name: "Cash Mgmt Counter",
    });
    assert.equal(registerRes.status, 201);
    registerMain = payload<{ data: { id: number } }>(registerRes).data.id;

    // Owner's open drawer: 1000 opening cash.
    const opened = await api(owner, "POST", `/api/registers/${registerMain}/open`, {
      openingCash: 1000,
    });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
  });

  /** Owner's live expected cash. */
  async function expectedCash(): Promise<number> {
    const current = await api(owner, "GET", "/api/sessions/current");
    assert.equal(current.status, 200);
    return payload<{ data: { expectedCash: number } }>(current).data.expectedCash;
  }

  /** Fully-paid cash sale of one line; returns {saleId, saleItemId}. */
  async function createCashSale(
    variantId: number,
    price: number,
    customerId: number | null = null,
  ): Promise<{ saleId: number; saleItemId: number }> {
    const res = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "cash", amount: price, tendered: price }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: price, discount: null }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const saleId = (res.body as { data: { sale: { id: number } } }).data.sale.id;
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const item = await client.query(
      "SELECT id FROM sale_items WHERE sale_id = $1 ORDER BY id LIMIT 1",
      [saleId],
    );
    await client.end();
    return { saleId, saleItemId: item.rows[0].id };
  }

  /** The session's transactions, newest first. */
  async function sessionTransactions(): Promise<
    { type: string; amount: number; referenceType: string | null; referenceId: number | null }[]
  > {
    const current = await api(owner, "GET", "/api/sessions/current");
    const sessionId = payload<{ data: { id: number } }>(current).data.id;
    const detail = await api(owner, "GET", `/api/sessions/${sessionId}`);
    assert.equal(detail.status, 200);
    return payload<{
      data: {
        transactions: {
          type: string;
          amount: number;
          referenceType: string | null;
          referenceId: number | null;
        }[];
      };
    }>(detail).data.transactions;
  }

  it("safe deposit/withdrawal and adjustments move expected cash by their type direction", async () => {
    const initial = await expectedCash();
    assert.equal(initial, 1000);
    let expected = initial;

    // cash-movement routes are session-scoped: resolve the session id first.
    const current = await api(owner, "GET", "/api/sessions/current");
    const sessionId = payload<{ data: { id: number } }>(current).data.id;
    const moved = await api(
      owner,
      "POST",
      `/api/sessions/${sessionId}/cash-movement`,
      { type: "safe_withdrawal", amount: 300, note: "safe → drawer" },
    );
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    expected += 300;
    assert.equal(payload<{ data: { expectedCash: number } }>(moved).data.expectedCash, expected);

    const deposit = await api(
      owner,
      "POST",
      `/api/sessions/${sessionId}/cash-movement`,
      { type: "safe_deposit", amount: 100, note: "drop to safe" },
    );
    assert.equal(deposit.status, 200);
    expected -= 100;
    assert.equal(payload<{ data: { expectedCash: number } }>(deposit).data.expectedCash, expected);

    const adjIn = await api(
      owner,
      "POST",
      `/api/sessions/${sessionId}/cash-movement`,
      { type: "adjustment_in", amount: 25, note: "found float" },
    );
    assert.equal(adjIn.status, 200);
    expected += 25;
    assert.equal(payload<{ data: { expectedCash: number } }>(adjIn).data.expectedCash, expected);

    const adjOut = await api(
      owner,
      "POST",
      `/api/sessions/${sessionId}/cash-movement`,
      { type: "adjustment_out", amount: 50, note: "miscount correction" },
    );
    assert.equal(adjOut.status, 200);
    expected -= 50;
    assert.equal(payload<{ data: { expectedCash: number } }>(adjOut).data.expectedCash, expected);
    assert.equal(expected, 1175);
  });

  it("a counter cash refund posts a cash_refund movement to the refunding drawer", async () => {
    const before = await expectedCash();
    const { saleId } = await createCashSale(variantExpensive, 100);
    const afterSale = await expectedCash();
    assert.equal(afterSale, before + 100, "cash sale increases expected cash");

    const refund = await api(
      owner,
      "POST",
      `/api/sold_products/refunds_all/${saleId}`,
      { reason: "customer_request", disposition: "restock" },
    );
    assert.equal(refund.status, 200, JSON.stringify(refund.body));

    const afterRefund = await expectedCash();
    assert.equal(afterRefund, afterSale - 100, "cash refund decreases expected cash");

    const transactions = await sessionTransactions();
    const refundMovement = transactions.find(
      (t) => t.type === "cash_refund" && t.referenceType === "sale_refund",
    );
    assert.ok(refundMovement, "a cash_refund movement was recorded");
    assert.equal(refundMovement.amount, 100);
    assert.ok(refundMovement.referenceId, "the movement references the refund record");
  });

  it("original_payment refunds never touch drawer cash", async () => {
    const before = await expectedCash();
    const { saleId } = await createCashSale(variantExpensive, 100);
    const refundMovementsBefore = (await sessionTransactions()).filter(
      (t) => t.referenceType === "sale_refund",
    ).length;

    const refund = await api(
      owner,
      "POST",
      `/api/sold_products/refunds_all/${saleId}`,
      {
        reason: "customer_request",
        disposition: "restock",
        refundMethod: "original_payment",
      },
    );
    assert.equal(refund.status, 200, JSON.stringify(refund.body));
    // A cash sale has no captured provider payment — the payout reports
    // NO_CAPTURED_PAYMENT after the ledger commits.
    const body = refund.body as {
      providerPayout: { paid: boolean; status: string } | null;
    };
    assert.equal(body.providerPayout?.status, "NO_CAPTURED_PAYMENT");

    const after = await expectedCash();
    assert.equal(after, before + 100, "only the sale moved the drawer");
    const refundMovementsAfter = (await sessionTransactions()).filter(
      (t) => t.referenceType === "sale_refund",
    ).length;
    assert.equal(
      refundMovementsAfter,
      refundMovementsBefore,
      "no new drawer movement for a provider refund",
    );
  });

  it("store_credit refunds never touch drawer cash", async () => {
    const customer = await api(owner, "POST", "/api/customers", {
      name: "Credit Customer",
      phone: `1711${String(stamp).slice(-6)}`,
    });
    assert.equal(customer.status, 201);
    const customerId = (customer.body as { id: number }).id;

    const before = await expectedCash();
    const { saleId } = await createCashSale(variantExpensive, 100, customerId);
    const afterSale = await expectedCash();

    const refund = await api(
      owner,
      "POST",
      `/api/sold_products/refunds_all/${saleId}`,
      {
        reason: "quality_issue",
        disposition: "damaged",
        refundMethod: "store_credit",
      },
    );
    assert.equal(refund.status, 200, JSON.stringify(refund.body));
    assert.equal(await expectedCash(), afterSale, "drawer unchanged by store credit");
    void before;
  });

  it("exchanges: collected cash difference enters the drawer, cash surplus leaves it", async () => {
    // Surplus payout: return a 100 item, replace with a 60 item, customer
    // takes 40 in cash (refundMethod defaults to cash for payouts).
    const before = await expectedCash();
    const saleA = await createCashSale(variantExpensive, 100);
    const afterSaleA = await expectedCash();

    const surplus = await api(owner, "POST", `/api/sales/${saleA.saleId}/exchange`, {
      returns: [{ saleItemId: saleA.saleItemId }],
      replacements: [{ variantId: variantCheap, quantity: 1 }],
      reason: "wrong_item",
      disposition: "restock",
      refundMethod: "cash",
    });
    assert.equal(surplus.status, 201, JSON.stringify(surplus.body));
    const surplusBody = surplus.body as { data: { difference: number } };
    assert.equal(surplusBody.data.difference, -40);
    assert.equal(
      await expectedCash(),
      afterSaleA - 40,
      "only the 40 cash surplus left the drawer — the returned 100 netted against the replacement",
    );

    // Collected difference: return a 60 item, replace with a 100 item,
    // customer pays 40 cash.
    const saleB = await createCashSale(variantCheap, 60);
    const afterSaleB = await expectedCash();
    const collect = await api(owner, "POST", `/api/sales/${saleB.saleId}/exchange`, {
      returns: [{ saleItemId: saleB.saleItemId }],
      replacements: [{ variantId: variantExpensive, quantity: 1 }],
      reason: "customer_request",
      disposition: "restock",
      additionalPayments: [
        { method: "cash", amount: 40, tendered: 40 },
      ],
    });
    assert.equal(collect.status, 201, JSON.stringify(collect.body));
    const collectBody = collect.body as { data: { difference: number } };
    assert.equal(collectBody.data.difference, 40);
    assert.equal(
      await expectedCash(),
      afterSaleB + 40,
      "the 40 cash difference entered the drawer",
    );
    void before;
  });

  it("cash due collections enter the collector's drawer; card collections do not", async () => {
    // Due-payment lines require the sale to carry a customer.
    const customer = await api(owner, "POST", "/api/customers", {
      name: "Due Customer",
      phone: `1777${String(stamp).slice(-6)}`,
    });
    assert.equal(customer.status, 201, JSON.stringify(customer.body));
    const customerId = (customer.body as { id: number }).id;

    // Partially-paid cash sale: 40 now, 60 due (the remainder rides as a
    // `due` payment — sales must be fully settled at creation).
    const saleRes = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [
        { method: "cash", amount: 40, tendered: 40 },
        { method: "due", amount: 60 },
      ],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: variantExpensive, quantity: 1, unitPrice: 100, discount: null }],
    });
    assert.equal(saleRes.status, 201, JSON.stringify(saleRes.body));
    const saleId = (saleRes.body as { data: { sale: { id: number } } }).data.sale.id;

    const before = await expectedCash();
    const pay = await api(owner, "POST", "/api/due-management/customer-payment", {
      saleId,
      amount: 60,
      paymentMethod: "cash",
    });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    assert.equal(
      (pay.body as { data: { outstandingAfter: number } }).data.outstandingAfter,
      0,
    );
    assert.equal(await expectedCash(), before + 60, "cash collection entered the drawer");

    const transactions = await sessionTransactions();
    const collection = transactions.find(
      (t) => t.type === "cash_in" && t.referenceType === "sale_payment",
    );
    assert.ok(collection, "the collection was recorded as a cash_in movement");

    // Card collection: a second partial sale settled by card — no movement.
    const cardSale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [
        { method: "card", amount: 40, reference: "DUE-CARD-1" },
        { method: "due", amount: 20 },
      ],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: variantCheap, quantity: 1, unitPrice: 60, discount: null }],
    });
    assert.equal(cardSale.status, 201, JSON.stringify(cardSale.body));
    const cardSaleId = (cardSale.body as { data: { sale: { id: number } } }).data.sale.id;
    const cardPay = await api(owner, "POST", "/api/due-management/customer-payment", {
      saleId: cardSaleId,
      amount: 20,
      paymentMethod: "card",
      reference: "DUE-CARD-2",
    });
    assert.equal(cardPay.status, 201, JSON.stringify(cardPay.body));
    assert.equal(await expectedCash(), before + 60, "card collection did not touch the drawer");
  });

  it("source-attributed movements are idempotent at the DB level", async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const current = await api(owner, "GET", "/api/sessions/current");
      const sessionId = payload<{ data: { id: number } }>(current).data.id;

      const transactions = await sessionTransactions();
      const saleMovement = transactions.find((t) => t.referenceType === "sale");
      assert.ok(saleMovement, "a sale movement exists from earlier tests");

      // A second drawer movement for the same source sale must be refused.
      const duplicate = await client.query(
        `INSERT INTO register_transactions
           (business_id, session_id, user_id, type, amount, reference_type, reference_id)
         VALUES ($1, $2, $3, 'sale', 1, $4, $5)`,
        [
          owner.businessId,
          sessionId,
          owner.userId,
          saleMovement.referenceType,
          saleMovement.referenceId,
        ],
      ).then(
        () => null,
        (err: { code?: string }) => err,
      );
      assert.ok(duplicate, "the duplicate insert must fail");
      assert.equal(duplicate.code, "23505", "unique violation on the reference index");

      // Manual movements (no source reference) remain unrestricted.
      const manual = await client.query(
        `INSERT INTO register_transactions
           (business_id, session_id, user_id, type, amount, reference_type)
         VALUES ($1, $2, $3, 'cash_in', 0.01, 'manual')
         RETURNING id`,
        [owner.businessId, sessionId, owner.userId],
      );
      assert.ok(manual.rowCount === 1);
      await client.query("DELETE FROM register_transactions WHERE id = $1", [
        manual.rows[0].id,
      ]);
    } finally {
      await client.end();
    }
  });

  it("session close stores expected vs counted with safe/adjustment math in the ledger", async () => {
    const current = await api(owner, "GET", "/api/sessions/current");
    const sessionId = payload<{ data: { id: number } }>(current).data.id;
    const expected = await expectedCash();

    const closed = await api(owner, "POST", `/api/sessions/${sessionId}/close`, {
      countedCash: expected - 20,
      notes: "cash mgmt close",
    });
    assert.equal(closed.status, 200);
    const closedSession = payload<{
      data: { expectedCash: number; countedCash: number; difference: number };
    }>(closed).data;
    assert.equal(closedSession.expectedCash, expected);
    assert.equal(closedSession.countedCash, expected - 20);
    assert.equal(closedSession.difference, -20);
  });
});
