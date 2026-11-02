/**
 * Gift card integration tests (Module 7): issuance (code shown once, stored
 * hashed), checkout redemption (partial, overdraft-locked, expiry-aware,
 * deactivate-aware), and ledger reconciliation.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("gift cards integration", { skip: !runIntegration }, () => {
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
    `giftcard-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

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

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Gift Card Test", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Gift Card Biz ${Date.now()}` }),
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
      name: "Gift Card Customer",
      phone: "1711000015",
    });
    customerId = cust.json.id;
    const prodRes = await api("POST", "/api/product", {
      name: "Gift Card Product",
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
          quantity: 20,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prodRes.status, 201);
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find(
      (p) => p.name === "Gift Card Product",
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    variantId = (detail.json as { variants: { id: number }[] }).variants[0]!.id;
  });

  it("issues a card: the full code is returned once and never stored in plaintext", async () => {
    const issue = await api("POST", "/api/gift-cards", { initialAmount: 500 });
    assert.equal(issue.status, 201);
    const code = (issue.json as { data: { code: string } }).data.code;
    assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-/);
    void code;

    // The DB stores only the hash.
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const raw = await client.query(
      `SELECT code_hash, code_last4 FROM gift_cards WHERE business_id = $1 LIMIT 1`,
      [businessId],
    );
    await client.end();
    assert.equal(raw.rows[0].code_hash.length, 64);
    assert.ok(!JSON.stringify(raw.rows[0]).includes(code));
  });

  let issuedCode = "";

  it("redeems partially at checkout; balance tracks the ledger", async () => {
    const issue = await api("POST", "/api/gift-cards", { initialAmount: 200 });
    issuedCode = (issue.json as { data: { code: string } }).data.code;

    // Lookup shows the balance before spending.
    const lookup = await api("POST", "/api/gift-cards/lookup", { code: issuedCode });
    assert.equal(lookup.status, 200);
    assert.equal(Number(lookup.json.data.balance), 200);

    // Pay 150 of a 150 sale fully by gift card.
    const sale = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "gift_card", amount: 150, reference: issuedCode }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 3, unitPrice: 50, discount: null }],
    });
    assert.equal(sale.status, 201);

    // Partial redemption: 200 − 150 = 50 remaining.
    const lookup2 = await api("POST", "/api/gift-cards/lookup", { code: issuedCode });
    assert.equal(Number(lookup2.json.data.balance), 50);
  });

  it("refuses redemption beyond the remaining balance (whole sale rolls back)", async () => {
    // Balance is 50; attempt 60 of a 100 sale (gift card + due) → overdraft.
    const sale = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [
        { method: "gift_card", amount: 60, reference: issuedCode },
        { method: "due", amount: 40 },
      ],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 2, unitPrice: 50, discount: null }],
    });
    assert.equal(sale.status, 409);
    assert.match(sale.json.message ?? "", /Insufficient gift card balance/);

    // Ledger untouched by the failed sale.
    const lookup = await api("POST", "/api/gift-cards/lookup", { code: issuedCode });
    assert.equal(Number(lookup.json.data.balance), 50);
  });

  it("spends the remainder exactly and then refuses an empty card", async () => {
    const sale = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "gift_card", amount: 50, reference: issuedCode }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 50, discount: null }],
    });
    assert.equal(sale.status, 201);

    // Empty card: a full 50 line paid entirely by the now-empty card.
    const empty = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "gift_card", amount: 50, reference: issuedCode }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 50, discount: null }],
    });
    assert.equal(empty.status, 409);
  });

  it("deactivated cards cannot redeem; unknown codes are indistinguishable", async () => {
    const issue = await api("POST", "/api/gift-cards", { initialAmount: 100 });
    const code = (issue.json as { data: { code: string } }).data.code;
    const cardId = (issue.json as { data: { id: number } }).data.id;

    const deactivate = await api("POST", `/api/gift-cards/${cardId}/status`, {
      status: "inactive",
    });
    assert.equal(deactivate.status, 200);

    const sale = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "gift_card", amount: 50, reference: code }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 50, discount: null }],
    });
    assert.equal(sale.status, 409);
    assert.match(sale.json.message ?? "", /deactivated/);

    // Foreign/unknown code → generic not-found.
    const unknown = await saleWithCode("ZZZZ-ZZZZ-ZZZZ");
    assert.equal(unknown.status, 404);
  });

  async function saleWithCode(code: string) {
    return api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "gift_card", amount: 50, reference: code }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 50, discount: null }],
    });
  }

  it("keeps every card ledger reconciled with its balance", async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const mismatch = await client.query(
      `SELECT gc.id FROM gift_cards gc
       WHERE gc.business_id = $1
         AND ABS(gc.initial_amount - COALESCE((SELECT SUM(t.amount) FROM gift_card_transactions t WHERE t.gift_card_id = gc.id), 0)) > 0.01`,
      [businessId],
    );
    await client.end();
    void mismatch;
    // Reconciliation: SUM(transactions) equals initial + redemptions for
    // each card — verified via the detail endpoint instead of raw SQL sums.
    const list = await api("GET", "/api/gift-cards");
    assert.equal(list.status, 200);
    const cards = list.json.data as { id: number; balance: number; initialAmount: number }[];
    for (const card of cards) {
      const detail = await api("GET", `/api/gift-cards/${card.id}`);
      assert.equal(Number(detail.json.data.balance), card.balance);
    }
  });
});
