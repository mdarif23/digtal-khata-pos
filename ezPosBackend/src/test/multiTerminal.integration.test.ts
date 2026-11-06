/**
 * Multi-terminal Phase 1 (cloud multi-PC POS): terminal binding/enforcement,
 * attribution, per-terminal drawer sessions, concurrent-sale safety and the
 * single invoice-numbering regime — all against the REAL Express app and
 * PostgreSQL (no mocks: concurrency claims are proven, not assumed).
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("multi-terminal Phase 1", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let dbClient: import("pg").Client;

  before(async () => {
    const { default: pg } = await import("pg");
    dbClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await dbClient.connect();
    const db = await dbClient.query("SELECT current_database() AS db");
    if (db.rows[0]?.db !== "ezpos_test") {
      throw new Error(
        `SAFETY ABORT: connected to "${db.rows[0]?.db}" — integration tests may only run against ezpos_test.`,
      );
    }
    await dbClient.query(
      `INSERT INTO subscription_plans (name, slug, interval, price, currency, is_active)
       VALUES ('Free trial', 'free-trial', 'monthly', 0, 'BDT', true)
       ON CONFLICT (slug) DO UPDATE SET is_active = true`,
    );
    const { ensureRbacSeed } = await import("../rbac/seed.js");
    await ensureRbacSeed();

    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server?.close();
    await dbClient?.end();
  });

  // ---------------------------------------------------------------------
  // Fixture
  // ---------------------------------------------------------------------
  const uniqueEmail = () =>
    `multiterminal-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let mainLocationId = 0;
  let backOfficeLocationId = 0;
  let unitId = 0;
  let customerId = 0;
  let variantId = 0; // 50 units @ 60
  let lastUnitVariantId = 0; // 1 unit @ 60
  let terminalMain = 0; // T1 @ Main
  let terminalMain2 = 0; // T2 @ Main
  let terminalBackOffice = 0; // T3 @ Back Office
  let foreignTerminalId = 0; // other business's terminal
  let registerA = 0;
  let registerB = 0;
  let otherBusinessId = 0;

  async function api(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(businessId ? { "X-Business-Id": String(businessId) } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  async function createProduct(name: string, price: number, qty: number) {
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
          sellingPrice: price,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: price / 2,
          quantity: qty,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prodRes.status, 201, `product ${name} create failed`);
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find(
      (p) => p.name === name,
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    return (detail.json as { variants: { id: number }[] }).variants[0]!.id;
  }

  async function insertTerminal(
    business: number,
    location: number,
    name: string,
    status = "active",
  ): Promise<number> {
    const res = await dbClient.query(
      `INSERT INTO pos_terminals (business_id, location_id, name, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [business, location, name, status],
    );
    return res.rows[0].id;
  }

  function salePayload(
    variant: number,
    quantity: number,
    extra: Record<string, unknown> = {},
  ) {
    return {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [
        { method: "cash", amount: 60 * quantity, tendered: 60 * quantity },
      ],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: variant, quantity, unitPrice: 60, discount: null }],
      ...extra,
    };
  }

  before(async () => {
    // Owner + business + two locations.
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Multi Terminal Owner", email, password: "strong-password-123" }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    token = ((await login.json()) as { accessToken: string }).accessToken;
    const biz = await api("POST", "/api/businesses", {
      name: `Multi Terminal Biz ${Date.now()}`,
    });
    assert.equal(biz.status, 201);
    businessId = biz.json.business.id;
    const loc = await api("POST", "/api/locations", { name: "Main Store" });
    assert.equal(loc.status, 201);
    const locs = await api("GET", "/api/locations");
    mainLocationId = locs.json.data.find((l: any) => l.name === "Main Store").id;
    const loc2 = await api("POST", "/api/locations", { name: "Back Office" });
    assert.equal(loc2.status, 201);
    const locs2 = await api("GET", "/api/locations");
    backOfficeLocationId = locs2.json.data.find((l: any) => l.name === "Back Office").id;

    const unit = await api("POST", "/api/product/unit", {
      unitName: "Piece",
      abbreviation: "Pcs",
    });
    unitId = unit.json.data.value;
    const cust = await api("POST", "/api/customers", {
      name: "MT Customer",
      phone: "1711000099",
    });
    customerId = cust.json.id;

    variantId = await createProduct("MT Product", 60, 50);
    lastUnitVariantId = await createProduct("MT Last Unit", 60, 1);

    // Terminals: two at Main, one at Back Office, one in a foreign business.
    terminalMain = await insertTerminal(businessId, mainLocationId, "Counter 1");
    terminalMain2 = await insertTerminal(businessId, mainLocationId, "Counter 2");
    terminalBackOffice = await insertTerminal(
      businessId,
      backOfficeLocationId,
      "Office PC",
    );

    // Foreign business + terminal straight in SQL: the terminal must
    // simply belong to ANOTHER business. password_hash is a placeholder —
    // nobody logs in as this user (crypt()/pgcrypto is not installed).
    const otherOwner = await dbClient.query(
      `INSERT INTO users (full_name, email, password_hash, is_active)
       VALUES ('Foreign Owner', $1, 'x', true) RETURNING id`,
      [`mt-foreign-${Date.now()}@example.test`],
    );
    otherBusinessId = (
      await dbClient.query(
        `INSERT INTO businesses (name, slug, created_by_user_id) VALUES ($1, $2, $3) RETURNING id`,
        [`MT Foreign Biz ${Date.now()}`, `mt-foreign-${Date.now()}`, otherOwner.rows[0].id],
      )
    ).rows[0].id;
    const otherLocation = (
      await dbClient.query(
        `INSERT INTO locations (business_id, name, is_default) VALUES ($1, 'Their Store', true) RETURNING id`,
        [otherBusinessId],
      )
    ).rows[0].id;
    foreignTerminalId = await insertTerminal(
      otherBusinessId,
      otherLocation,
      "Their Counter",
    );

    // Registers for the drawer tests.
    const regA = await api("POST", "/api/registers", { name: "Drawer A" });
    assert.equal(regA.status, 201);
    registerA = regA.json.data.id;
    const regB = await api("POST", "/api/registers", { name: "Drawer B" });
    assert.equal(regB.status, 201);
    registerB = regB.json.data.id;
  });

  // ---------------------------------------------------------------------
  // Terminal binding + enforcement
  // ---------------------------------------------------------------------

  it("attributes a sale to the bound terminal", async () => {
    const res = await api(
      "POST",
      "/api/sales",
      salePayload(variantId, 1),
      { "X-Terminal-Id": String(terminalMain) },
    );
    assert.equal(res.status, 201);
    const saleId = res.json.data.sale.id;
    const row = await dbClient.query(
      `SELECT terminal_id FROM sales WHERE id = $1 AND business_id = $2`,
      [saleId, businessId],
    );
    assert.equal(row.rows[0].terminal_id, terminalMain);
  });

  it("accepts a sale without a terminal header (backward compatible)", async () => {
    const res = await api("POST", "/api/sales", salePayload(variantId, 1));
    assert.equal(res.status, 201);
    const saleId = res.json.data.sale.id;
    const row = await dbClient.query(
      `SELECT terminal_id FROM sales WHERE id = $1`,
      [saleId],
    );
    assert.equal(row.rows[0].terminal_id, null);
  });

  it("rejects unknown, foreign-business and foreign-location terminals with TERMINAL_REVOKED", async () => {
    for (const terminalId of [999999, foreignTerminalId, terminalBackOffice]) {
      const res = await api(
        "POST",
        "/api/sales",
        salePayload(variantId, 1),
        { "X-Terminal-Id": String(terminalId) },
      );
      assert.equal(res.status, 403, `terminal ${terminalId} should be rejected`);
      assert.equal(res.json.code, "TERMINAL_REVOKED");
    }
  });

  it("a deactivated terminal cannot sell until reactivated", async () => {
    await dbClient.query(
      `UPDATE pos_terminals SET status = 'inactive' WHERE id = $1`,
      [terminalMain2],
    );
    const rejected = await api(
      "POST",
      "/api/sales",
      salePayload(variantId, 1),
      { "X-Terminal-Id": String(terminalMain2) },
    );
    assert.equal(rejected.status, 403);
    assert.equal(rejected.json.code, "TERMINAL_REVOKED");

    // Reactivate through the admin API (the "Activate" action).
    const patched = await api("PATCH", `/api/terminals/${terminalMain2}`, {
      status: "active",
    });
    assert.equal(patched.status, 200);
    const ok = await api(
      "POST",
      "/api/sales",
      salePayload(variantId, 1),
      { "X-Terminal-Id": String(terminalMain2) },
    );
    assert.equal(ok.status, 201);
  });

  it("strict mode (require_terminal) blocks unbound checkouts", async () => {
    const patch = await api("PATCH", "/api/pos-settings", {
      requireTerminal: true,
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.json.data.requireTerminal, true);

    const blocked = await api("POST", "/api/sales", salePayload(variantId, 1));
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, "TERMINAL_REQUIRED");

    const bound = await api(
      "POST",
      "/api/sales",
      salePayload(variantId, 1),
      { "X-Terminal-Id": String(terminalMain) },
    );
    assert.equal(bound.status, 201);

    const reset = await api("PATCH", "/api/pos-settings", {
      requireTerminal: false,
    });
    assert.equal(reset.status, 200);
  });

  it("reassigning a terminal to another location revokes it at the old one", async () => {
    const moved = await api("PATCH", `/api/terminals/${terminalMain2}`, {
      locationId: backOfficeLocationId,
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.data.locationId, backOfficeLocationId);

    const rejected = await api(
      "POST",
      "/api/sales",
      salePayload(variantId, 1),
      { "X-Terminal-Id": String(terminalMain2) },
    );
    assert.equal(rejected.status, 403);

    const back = await api("PATCH", `/api/terminals/${terminalMain2}`, {
      locationId: mainLocationId,
    });
    assert.equal(back.status, 200);
  });

  it("a terminal with sales history cannot be deleted", async () => {
    const res = await api("DELETE", `/api/terminals/${terminalMain}`);
    assert.equal(res.status, 409);
  });

  // ---------------------------------------------------------------------
  // Concurrency (real parallel HTTP, real Postgres locks)
  // ---------------------------------------------------------------------

  it("two simultaneous sales of the LAST unit: exactly one wins", async () => {
    const [a, b] = await Promise.all([
      api("POST", "/api/sales", salePayload(lastUnitVariantId, 1)),
      api("POST", "/api/sales", salePayload(lastUnitVariantId, 1)),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(
      statuses,
      [201, 404],
      `expected one win + one stock-loss, got ${JSON.stringify([a.json, b.json])}`,
    );

    const stock = await dbClient.query(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [lastUnitVariantId, businessId],
    );
    assert.equal(Number(stock.rows[0].quantity), 0);
    const movements = await dbClient.query(
      `SELECT count(*)::int AS n FROM inventory_movements
       WHERE variant_id = $1 AND business_id = $2 AND movement_type = 'sale'`,
      [lastUnitVariantId, businessId],
    );
    assert.equal(movements.rows[0].n, 1);
  });

  it("concurrent duplicate idempotency keys produce ONE sale; a different payload with the same key is 409", async () => {
    const key = `mt-race-${Date.now()}`;
    const before = await dbClient.query(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [variantId, businessId],
    );
    const stockBefore = Number(before.rows[0].quantity);

    const payload = salePayload(variantId, 2, { idempotencyKey: key });
    const [a, b] = await Promise.all([
      api("POST", "/api/sales", payload),
      api("POST", "/api/sales", payload),
    ]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(a.json.data.sale.id, b.json.data.sale.id);
    assert.equal(a.json.data.sale.invoiceNumber, b.json.data.sale.invoiceNumber);

    const sales = await dbClient.query(
      `SELECT count(*)::int AS n FROM sales WHERE business_id = $1 AND idempotency_key = $2`,
      [businessId, key],
    );
    assert.equal(sales.rows[0].n, 1);
    const stock = await dbClient.query(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [variantId, businessId],
    );
    assert.equal(Number(stock.rows[0].quantity), stockBefore - 2);

    // Same key, DIFFERENT payload → refused, never silently replayed.
    const tampered = await api(
      "POST",
      "/api/sales",
      salePayload(variantId, 5, { idempotencyKey: key }),
    );
    assert.equal(tampered.status, 409);
  });

  it("online orders and POS share one per-business invoice counter (R2)", async () => {
    // A POS sale just allocated from document_sequences; an online order for
    // the same business must continue the SAME counter without colliding.
    const pos = await api("POST", "/api/sales", salePayload(variantId, 1));
    assert.equal(pos.status, 201);
    const posInvoice = pos.json.data.sale.invoiceNumber as string;

    const { createOnlineOrder } = await import(
      "../modules/commerce/orders.service.js"
    );
    const order = await createOnlineOrder({
      businessId,
      channel: "custom_storefront",
      integrationId: null,
      customer: { name: "MT Orderer", phone: "1700000000" },
      lines: [{ variantId, quantity: 1 }],
      idempotencyKey: `mt-order-${Date.now()}`,
    });
    assert.notEqual(order.invoiceNumber, posInvoice);
    const distinct = await dbClient.query(
      `SELECT count(*)::int AS n FROM sales WHERE business_id = $1 AND invoice_number = $2`,
      [businessId, order.invoiceNumber],
    );
    assert.equal(distinct.rows[0].n, 1);
  });

  // ---------------------------------------------------------------------
  // Per-terminal cash drawer sessions
  // ---------------------------------------------------------------------

  it("drawer sessions bind to terminals; policy gates a second session", async () => {
    const openA = await api(
      "POST",
      `/api/registers/${registerA}/open`,
      { openingCash: 1000 },
      { "X-Terminal-Id": String(terminalMain) },
    );
    assert.equal(openA.status, 201);
    assert.equal(openA.json.data.terminalId, terminalMain);
    assert.equal(openA.json.data.terminalName, "Counter 1");
    const sessionA = openA.json.data.id;
    const row = await dbClient.query(
      `SELECT terminal_id FROM register_sessions WHERE id = $1`,
      [sessionA],
    );
    assert.equal(row.rows[0].terminal_id, terminalMain);

    // Default policy: one open session per user — even from another terminal.
    const second = await api(
      "POST",
      `/api/registers/${registerB}/open`,
      { openingCash: 500 },
      { "X-Terminal-Id": String(terminalMain2) },
    );
    assert.equal(second.status, 409);

    // Allow multiple: same cashier, two terminals, two drawers.
    const patch = await api("PATCH", "/api/pos-settings", {
      allowMultipleDrawerSessions: true,
    });
    assert.equal(patch.status, 200);
    const openB = await api(
      "POST",
      `/api/registers/${registerB}/open`,
      { openingCash: 500 },
      { "X-Terminal-Id": String(terminalMain2) },
    );
    assert.equal(openB.status, 201);
    const sessionB = openB.json.data.id;
    assert.equal(openB.json.data.terminalId, terminalMain2);

    // A cash sale from terminal 2 lands in the TERMINAL-2 drawer (the
    // physical drawer that actually received the cash), not the cashier's
    // other session.
    const sale = await api(
      "POST",
      "/api/sales",
      salePayload(variantId, 1),
      { "X-Terminal-Id": String(terminalMain2) },
    );
    assert.equal(sale.status, 201);
    const movements = await dbClient.query(
      `SELECT session_id, amount FROM register_transactions
       WHERE business_id = $1 AND reference_type = 'sale' AND reference_id = $2`,
      [businessId, sale.json.data.sale.id],
    );
    assert.equal(movements.rows.length, 1);
    assert.equal(movements.rows[0].session_id, sessionB);

    const reset = await api("PATCH", "/api/pos-settings", {
      allowMultipleDrawerSessions: false,
    });
    assert.equal(reset.status, 200);

    // Clean up both sessions for later suites (close with counted = expected).
    for (const sessionId of [sessionA, sessionB]) {
      const detail = await api("GET", `/api/sessions/${sessionId}`);
      const expected = Number(detail.json.data.expectedCash);
      const closed = await api("POST", `/api/sessions/${sessionId}/close`, {
        countedCash: expected,
      });
      assert.ok([200, 201].includes(closed.status), JSON.stringify(closed.json));
    }
  });
});
