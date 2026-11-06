/**
 * LAN sync (Phase 2) — CLOUD side: sync-agent authentication, bootstrap
 * snapshot, catalog/stock/customers pulls, and idempotent op application.
 * The agent half (push/pull orchestration) is proven in
 * syncAgent.integration.test.ts against a scripted cloud.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { hashTerminalSecret } from "../middleware/terminalAuth.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("LAN sync cloud API (Phase 2)", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let dbClient: import("pg").Client;

  before(async () => {
    const { default: pg } = await import("pg");
    dbClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await dbClient.connect();
    if ((await dbClient.query("SELECT current_database() AS db")).rows[0]?.db !== "ezpos_test") {
      throw new Error("SAFETY ABORT: integration tests may only run against ezpos_test.");
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

  const uniqueEmail = () =>
    `lansync-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let mainLocationId = 0;
  let secondLocationId = 0;
  let unitId = 0;
  let customerId = 0;
  let variantId = 0;
  let agentSecret = "";
  let agentTerminalId = 0;
  let plainTerminalId = 0;

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
        "X-Business-Id": String(businessId),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  function agentHeaders(secret = agentSecret): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
      "X-Terminal-Id": String(agentTerminalId),
    };
  }

  async function syncApi(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = agentHeaders(),
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "LAN Sync Owner", email, password: "strong-password-123" }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    token = ((await login.json()) as { accessToken: string }).accessToken;
    const biz = await api("POST", "/api/businesses", { name: `LAN Sync Biz ${Date.now()}` });
    assert.equal(biz.status, 201);
    businessId = biz.json.business.id;
    const loc = await api("POST", "/api/locations", { name: "Main Store" });
    assert.equal(loc.status, 201);
    const locs = await api("GET", "/api/locations");
    mainLocationId = locs.json.data.find((l: any) => l.name === "Main Store").id;
    const loc2 = await api("POST", "/api/locations", { name: "Second" });
    assert.equal(loc2.status, 201);
    const locs2 = await api("GET", "/api/locations");
    secondLocationId = locs2.json.data.find((l: any) => l.name === "Second").id;

    const unit = await api("POST", "/api/product/unit", { unitName: "Piece", abbreviation: "Pcs" });
    unitId = unit.json.data.value;
    const cust = await api("POST", "/api/customers", { name: "LAN Customer", phone: "1722000011" });
    customerId = cust.json.id;
    const prodRes = await api("POST", "/api/product", {
      name: "LAN Product",
      categoryId: null, brandId: null, unitId, description: "", productType: "physical",
      hasVariants: false, trackingType: "none", supplierId: null, status: "active",
      imageUrl: null, imageFile: null, source: "opening",
      variants: [{ sku: "", barcode: null, sellingPrice: 80, alertQuantity: 0, isDefault: true,
        status: "active", imageUrl: null, imageFile: null, batchNumber: "", purchasePrice: 40,
        quantity: 25, expiryDate: null }],
    });
    assert.equal(prodRes.status, 201);
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find((p) => p.name === "LAN Product")!;
    const detail = await api("GET", `/api/product/${found.id}`);
    variantId = (detail.json as { variants: { id: number }[] }).variants[0]!.id;

    agentSecret = `ezpos_tb_${randomBytes(12).toString("hex")}`;
    agentTerminalId = (
      await dbClient.query(
        `INSERT INTO pos_terminals (business_id, location_id, name, is_sync_agent, secret_hash)
         VALUES ($1, $2, 'LAN Server', true, $3) RETURNING id`,
        [businessId, mainLocationId, hashTerminalSecret(agentSecret)],
      )
    ).rows[0].id;
    plainTerminalId = (
      await dbClient.query(
        `INSERT INTO pos_terminals (business_id, location_id, name, secret_hash)
         VALUES ($1, $2, 'Bridge Only', $3) RETURNING id`,
        [businessId, mainLocationId, hashTerminalSecret(`ezpos_tb_${randomBytes(12).toString("hex")}`)],
      )
    ).rows[0].id;
  });

  it("authenticates only the designated sync agent", async () => {
    // A paired-but-not-agent terminal with a VALID secret is refused.
    const bridgeHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ezpos_tb_wrong`,
      "X-Terminal-Id": String(agentTerminalId),
    };
    const wrongSecret = await syncApi("GET", "/api/sync/bootstrap", undefined, bridgeHeaders);
    assert.equal(wrongSecret.status, 401);

    const plainHeaders = {
      "Content-Type": "application/json",
      "X-Terminal-Id": String(plainTerminalId),
    };
    // Extract the plain terminal's secret? We cannot — use a fresh valid
    // secret for a NEW non-agent terminal to prove the capability gate.
    const plainSecret = `ezpos_tb_${randomBytes(12).toString("hex")}`;
    await dbClient.query(`UPDATE pos_terminals SET secret_hash = $1 WHERE id = $2`, [
      hashTerminalSecret(plainSecret),
      plainTerminalId,
    ]);
    const notAgent = await syncApi("GET", "/api/sync/bootstrap", undefined, {
      ...plainHeaders,
      Authorization: `Bearer ${plainSecret}`,
    });
    assert.equal(notAgent.status, 403);
    assert.equal(notAgent.json.code, "SYNC_AGENT_REQUIRED");

    const ok = await syncApi("GET", "/api/sync/bootstrap");
    assert.equal(ok.status, 200);
  });

  it("bootstrap carries identity, plans and the permissions catalog", async () => {
    const res = await syncApi("GET", "/api/sync/bootstrap");
    assert.equal(res.status, 200);
    const data = res.json.data;
    assert.equal(data.business.id, businessId);
    assert.ok(data.locations.length >= 2);
    assert.ok(data.users.length >= 1);
    assert.ok(data.plans.length >= 1);
    assert.ok(data.permissions.length >= 1);
    assert.equal(data.terminal.locationId, mainLocationId);
  });

  it("catalog delta returns the full tree first, then only changes", async () => {
    const full = await syncApi("GET", "/api/sync/catalog");
    assert.equal(full.status, 200);
    const myProductId = await productIdByName();
    const fullProduct = full.json.data.products.find((p: any) => p.id === myProductId);
    assert.ok(fullProduct, "full pull includes the product");
    assert.ok(full.json.data.variants.some((v: any) => v.id === variantId));
    const cursor = full.json.data.cursor as string;

    const unchanged = await syncApi("GET", `/api/sync/catalog?since=${encodeURIComponent(cursor)}`);
    assert.equal(unchanged.status, 200);
    assert.equal(unchanged.json.data.products.length, 0);

    // A price change on the VARIANT must surface through the product tree.
    await dbClient.query(
      `UPDATE product_variants SET selling_price = 90 WHERE id = $1`,
      [variantId],
    );
    const delta = await syncApi("GET", `/api/sync/catalog?since=${encodeURIComponent(cursor)}`);
    assert.equal(delta.status, 200);
    assert.ok(delta.json.data.variants.some((v: any) => v.id === variantId));
    assert.ok(delta.json.data.cursor > cursor);
  });

  async function productIdByName(): Promise<number> {
    const row = await dbClient.query(
      `SELECT id FROM products WHERE business_id = $1 AND name = 'LAN Product'`,
      [businessId],
    );
    return row.rows[0].id;
  }

  it("stock snapshot is scoped to the agent's location and includes batches", async () => {
    // Ring a sale so stock + a batch exist. The catalog test above raised
    // the trusted price to 90 — payments must match the DB price, not the
    // seeded one (the server never trusts client prices).
    const sale = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 180, tendered: 180 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 2, unitPrice: 90, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.json));

    const res = await syncApi("GET", "/api/sync/stock");
    assert.equal(res.status, 200);
    const data = res.json.data;
    assert.equal(data.locationId, mainLocationId);
    const stockRow = data.stock.find((s: any) => s.variantId === variantId);
    assert.ok(stockRow, "stock row present");
    assert.equal(Number(stockRow.quantity), 23);
    assert.ok(data.batches.some((b: any) => Number(b.quantityRemaining) > 0));
  });

  it("customer.create is idempotent by clientUuid", async () => {
    const op = {
      opId: `cust-op-${Date.now()}`,
      type: "customer.create",
      payload: { clientUuid: "3f9d1c00-0000-4000-8000-000000000001", name: "Synced Customer", phone: "1733000022" },
    };
    const first = await syncApi("POST", "/api/sync/ops", { ops: [op] });
    assert.equal(first.status, 200);
    assert.equal(first.json.data.results[0].status, "applied");
    const cloudId = first.json.data.results[0].customerId;

    const replay = await syncApi("POST", "/api/sync/ops", { ops: [op] });
    assert.equal(replay.json.data.results[0].status, "duplicate");
    assert.equal(replay.json.data.results[0].customerId, cloudId);
  });

  it("sale.create applies a replica, deducts stock, replays idempotently", async () => {
    const idempotencyKey = `lan-sale-${Date.now()}`;
    const op = {
      opId: idempotencyKey,
      type: "sale.create",
      payload: {
        locationId: mainLocationId,
        cashierUserId: null,
        terminalName: "Counter 1 (LAN)",
        sale: {
          saleDate: new Date().toISOString(),
          customerId: null,
          payments: [{ method: "cash", amount: 90, tendered: 90 }],
          discount: null,
          vatPercent: 0,
          idempotencyKey,
          items: [{ variantId, quantity: 1, unitPrice: 90, discount: null }],
        },
      },
    };
    const first = await syncApi("POST", "/api/sync/ops", { ops: [op] });
    assert.equal(first.status, 200);
    assert.equal(first.json.data.results[0].status, "applied", JSON.stringify(first.json.data.results));
    const invoice = first.json.data.results[0].invoiceNumber as string;
    assert.ok(invoice);

    const saleRow = await dbClient.query(
      `SELECT channel, idempotency_payload_hash IS NOT NULL AS has_hash FROM sales
       WHERE business_id = $1 AND idempotency_key = $2`,
      [businessId, idempotencyKey],
    );
    assert.equal(saleRow.rows[0].channel, "offline");

    const stockAfterFirst = await dbClient.query(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [variantId, businessId],
    );

    // Crash-before-ack replay: the SAME op applies again → same invoice.
    const replay = await syncApi("POST", "/api/sync/ops", { ops: [op] });
    assert.equal(replay.json.data.results[0].status, "applied");
    assert.equal(replay.json.data.results[0].invoiceNumber, invoice);

    const stockAfterReplay = await dbClient.query(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [variantId, businessId],
    );
    assert.equal(
      Number(stockAfterReplay.rows[0].quantity),
      Number(stockAfterFirst.rows[0].quantity),
      "replay must not deduct stock twice",
    );
  });

  it("sale.create for another location is rejected", async () => {
    const op = {
      opId: `lan-wrongloc-${Date.now()}`,
      type: "sale.create",
      payload: {
        locationId: secondLocationId,
        cashierUserId: null,
        terminalName: "Counter 1 (LAN)",
        sale: {
          saleDate: new Date().toISOString(),
          customerId: null,
          payments: [{ method: "cash", amount: 90, tendered: 90 }],
          discount: null,
          vatPercent: 0,
          idempotencyKey: `lan-wrongloc-${Date.now()}`,
          items: [{ variantId, quantity: 1, unitPrice: 90, discount: null }],
        },
      },
    };
    const res = await syncApi("POST", "/api/sync/ops", { ops: [op] });
    assert.equal(res.json.data.results[0].status, "failed");
    assert.match(res.json.data.results[0].error, /location/);
  });

  it("sync status counts only un-synced POS sales, not offline replicas", async () => {
    // Two offline-channel replicas exist by now — neither counts. The only
    // pending row is this suite's own POS sale from the stock-snapshot test.
    const res = await api("GET", "/api/sync/status");
    assert.equal(res.status, 200);
    assert.equal(res.json.data.pendingCount, 1);
    assert.equal(res.json.data.agentEnabled, false);
  });
});
