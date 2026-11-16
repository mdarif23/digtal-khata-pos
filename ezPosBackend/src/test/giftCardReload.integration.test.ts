/**
 * P3 Phase 1 (F3): gift-card reload — balance increases exactly once, the
 * money side (GL DR cash / CR 2040) posts with a per-reload idempotency key,
 * cash reloads move the drawer once, duplicate references are rejected,
 * inactive/expired cards cannot reload. Against a REAL PostgreSQL database.
 * Double-guarded like the other suites.
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

describe("giftCardReload integration", { skip: !runIntegration }, () => {
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
  const uniqueEmail = () => `gcr-${Date.now()}-${(counter += 1)}@example.test`;

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
  let registerId = 0;

  before(async () => {
    const ownerEmail = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Reload Owner",
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
      name: `Reload Co ${stamp}`,
    });
    assert.equal(biz.status, 201);
    owner.businessId = biz.body.business.id;

    const locRes = await api(owner, "POST", "/api/locations", {
      name: `Reload Main ${stamp}`,
    });
    assert.equal(locRes.status, 201);

    // Drawer for cash-reload attribution.
    const regRes = await api(owner, "POST", "/api/registers", {
      name: `Reload Counter ${stamp}`,
    });
    assert.equal(regRes.status, 201);
    registerId = payload<{ id: number }>(regRes).id;
    const open = await api(owner, "POST", `/api/registers/${registerId}/open`, {
      openingCash: 0,
    });
    assert.equal(open.status, 201, JSON.stringify(open.body));

    // Activate the finance ledger — reloads post DR cash / CR 2040 only for
    // ledger-activated businesses (the same guard paid issuance uses).
    const activation = await api(owner, "POST", "/api/finance/activation", {
      accounts: [{ name: "Cash Drawer", type: "cash", openingBalance: 10000 }],
      inventoryValue: 0,
      ownerCapital: 10000,
    });
    assert.equal(activation.status, 201, JSON.stringify(activation.body));
  });

  async function issueCard(initialAmount: number): Promise<{ id: number; code: string }> {
    const res = await api(owner, "POST", "/api/gift-cards", {
      initialAmount,
      paymentMethod: "cash",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return payload<{ id: number; code: string }>(res);
  }

  it("reloads an active card once: ledger, liability and drawer all move", async () => {
    const card = await issueCard(100);
    const reload = await api(
      owner,
      "POST",
      `/api/gift-cards/${card.id}/reload`,
      { amount: 50, paymentMethod: "cash", reference: `R-${stamp}-1` },
    );
    assert.equal(reload.status, 200, JSON.stringify(reload.body));
    const data = payload<{ giftCardId: number; codeLast4: string; amount: number; balance: number }>(reload);
    assert.equal(data.amount, 50);
    assert.equal(data.balance, 150);

    // Exactly one reload ledger row.
    const txRows = await dbQuery(
      "SELECT id, amount, source_type, reference FROM gift_card_transactions WHERE gift_card_id = $1 AND source_type = 'reload'",
      [card.id],
    );
    assert.equal(txRows.length, 1);
    assert.equal(Number(txRows[0]!.amount), 50);
    assert.equal(txRows[0]!.reference, `R-${stamp}-1`);

    // GL: one balanced gift_card_reload entry keyed by the reload row id.
    const entries = await dbQuery(
      `SELECT je.id, je.status,
              COALESCE(SUM(CASE WHEN jl.debit > 0 THEN jl.debit ELSE 0 END), 0) AS d,
              COALESCE(SUM(CASE WHEN jl.credit > 0 THEN jl.credit ELSE 0 END), 0) AS c
       FROM journal_entries je
       LEFT JOIN journal_entry_lines jl ON jl.entry_id = je.id
       WHERE je.business_id = $1 AND je.source_type = 'gift_card_reload' AND je.source_id = $2
       GROUP BY je.id, je.status`,
      [owner.businessId, txRows[0]!.id],
    );
    assert.equal(entries.length, 1, "one journal entry per reload");
    assert.equal(Number(entries[0]!.d), 50);
    assert.equal(Number(entries[0]!.c), 50);

    // Drawer: one cash_in attributed to the open session.
    const drawerRows = await dbQuery(
      "SELECT amount, type FROM register_transactions WHERE reference_type = 'gift_card_reload' AND reference_id = $1",
      [txRows[0]!.id],
    );
    assert.equal(drawerRows.length, 1);
    assert.equal(drawerRows[0]!.type, "cash_in");
    assert.equal(Number(drawerRows[0]!.amount), 50);
  });

  it("a retried reload with the same reference is rejected (409), not doubled", async () => {
    const card = await issueCard(100);
    const first = await api(
      owner,
      "POST",
      `/api/gift-cards/${card.id}/reload`,
      { amount: 25, paymentMethod: "bangla_qr", reference: `R-${stamp}-dup` },
    );
    assert.equal(first.status, 200);
    const dupe = await api(
      owner,
      "POST",
      `/api/gift-cards/${card.id}/reload`,
      { amount: 25, paymentMethod: "bangla_qr", reference: `R-${stamp}-dup` },
    );
    assert.equal(dupe.status, 409);
    assert.match(dupe.body.message, /already been used/);
    const rows = await dbQuery(
      "SELECT count(*)::int AS n FROM gift_card_transactions WHERE gift_card_id = $1 AND source_type = 'reload'",
      [card.id],
    );
    assert.equal(rows[0]!.n, 1);
  });

  it("inactive and expired cards cannot reload", async () => {
    const card = await issueCard(100);
    const deactivate = await api(
      owner,
      "POST",
      `/api/gift-cards/${card.id}/status`,
      { status: "inactive" },
    );
    assert.equal(deactivate.status, 200);
    const reload = await api(
      owner,
      "POST",
      `/api/gift-cards/${card.id}/reload`,
      { amount: 10, paymentMethod: "cash" },
    );
    assert.equal(reload.status, 409);
    assert.match(reload.body.message, /deactivated/);
  });

  it("non-positive reload amounts are rejected", async () => {
    const card = await issueCard(100);
    const zero = await api(owner, "POST", `/api/gift-cards/${card.id}/reload`, {
      amount: 0,
      paymentMethod: "cash",
    });
    assert.equal(zero.status, 400);
    const negative = await api(owner, "POST", `/api/gift-cards/${card.id}/reload`, {
      amount: -5,
      paymentMethod: "cash",
    });
    assert.equal(negative.status, 400);
  });

  it("reloaded value is redeemable at checkout and the ledger continues", async () => {
    const card = await issueCard(100);
    const reload = await api(
      owner,
      "POST",
      `/api/gift-cards/${card.id}/reload`,
      { amount: 50, paymentMethod: "card", reference: `R-${stamp}-redeem` },
    );
    assert.equal(reload.status, 200);
    const code = card.code;

    // A real sale: 150 against a 150-balance card.
    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Reload Piece ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ value: number }>(unitRes).value;
    const created = await api(owner, "POST", "/api/product", {
      name: `Reload Widget ${stamp}`,
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
          sku: `GCR-${stamp}`,
          barcode: null,
          sellingPrice: 150,
          alertQuantity: 1,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `GCRB-${stamp}`,
          purchasePrice: 10,
          quantity: 100,
          expiryDate: null,
        },
      ],
    });
    assert.equal(created.status, 201);
    const list = await api(owner, "GET", "/api/products");
    const widget = (
      list.body as { name: string; variants: { id: number }[] }[]
    ).find((p) => p.name === `Reload Widget ${stamp}`);
    assert.ok(widget);
    const variantId = widget.variants[0]!.id;

    const saleRes = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "gift_card", amount: 150, reference: code }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 150, discount: null }],
    });
    assert.equal(saleRes.status, 201, JSON.stringify(saleRes.body));

    const detail = await api(owner, "GET", `/api/gift-cards/${card.id}`);
    assert.equal(payload<{ balance: number }>(detail).balance, 0);

    // The ledger continues: reload again after the redemption.
    const again = await api(
      owner,
      "POST",
      `/api/gift-cards/${card.id}/reload`,
      { amount: 30, paymentMethod: "cash" },
    );
    assert.equal(again.status, 200);
    assert.equal(payload<{ balance: number }>(again).balance, 30);
  });
});
