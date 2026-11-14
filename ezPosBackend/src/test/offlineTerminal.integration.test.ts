/**
 * Offline terminals (Phase 3): server-enforced stock allocations that two
 * disconnected terminals cannot double-spend, open-mode conflicts, the
 * offline op surface (sale/customer/drawer), and manager review. Real
 * Postgres, real HTTP.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("offline terminals (Phase 3)", { skip: !runIntegration, concurrency: 1 }, () => {
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
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await dbClient?.end();
  });

  const uniqueEmail = () =>
    `offline-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let mainLocationId = 0;
  let unitId = 0;
  let customerId = 0;
  let allocatedVariantId = 0; // stock 10, policy allocated
  let openVariantId = 0; // stock 2, policy open
  let serialVariantId = 0; // serial-tracked
  let terminalA = 0;
  let terminalB = 0;
  let registerA = 0;

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

  async function createProduct(
    name: string,
    price: number,
    qty: number,
    trackingType: "none" | "serial",
  ) {
    const prodRes = await api("POST", "/api/product", {
      name,
      categoryId: null, brandId: null, unitId, description: "", productType: "physical",
      hasVariants: false, trackingType, supplierId: null, status: "active",
      imageUrl: null, imageFile: null, source: "opening",
      variants: [{
        sku: "", barcode: null, sellingPrice: price, alertQuantity: 0, isDefault: true,
        status: "active", imageUrl: null, imageFile: null, batchNumber: "",
        purchasePrice: price / 2, quantity: qty,
        expiryDate: null,
        ...(trackingType === "serial"
          ? {
              serialNumbers: Array.from({ length: Math.max(qty, 1) }, (_, i) => ({
                serial: `SN-${name.replace(/\s+/g, "")}-${Date.now()}-${i}`,
              })),
            }
          : {}),
      }],
    });
    assert.equal(prodRes.status, 201, JSON.stringify(prodRes.json));
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find((p) => p.name === name)!;
    const detail = await api("GET", `/api/product/${found.id}`);
    return (detail.json as { variants: { id: number }[] }).variants[0]!.id;
  }

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Offline Owner", email, password: "strong-password-123" }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    token = ((await login.json()) as { accessToken: string }).accessToken;
    const biz = await api("POST", "/api/businesses", { name: `Offline Biz ${Date.now()}` });
    assert.equal(biz.status, 201);
    businessId = biz.json.business.id;
    const loc = await api("POST", "/api/locations", { name: "Main Store" });
    assert.equal(loc.status, 201);
    const locs = await api("GET", "/api/locations");
    mainLocationId = locs.json.data.find((l: any) => l.name === "Main Store").id;
    const unit = await api("POST", "/api/product/unit", { unitName: "Piece", abbreviation: "Pcs" });
    unitId = unit.json.data.value;
    const cust = await api("POST", "/api/customers", { name: "Offline Cust", phone: "1755000044" });
    customerId = cust.json.id;

    allocatedVariantId = await createProduct("Off Allocated", 60, 10, "none");
    openVariantId = await createProduct("Off Open", 60, 2, "none");
    serialVariantId = await createProduct("Off Serial", 100, 2, "serial");

    await dbClient.query(`UPDATE products SET offline_policy = 'open' WHERE name = 'Off Open'`);
    await dbClient.query(`UPDATE products SET offline_policy = 'blocked' WHERE name = 'Off Serial'`);

    // Two terminals + a register for the drawer tests.
    for (const name of ["Offline T1", "Offline T2"]) {
      const id = (
        await dbClient.query(
          `INSERT INTO pos_terminals (business_id, location_id, name) VALUES ($1, $2, $3) RETURNING id`,
          [businessId, mainLocationId, name],
        )
      ).rows[0].id;
      if (name === "Offline T1") terminalA = id;
      else terminalB = id;
    }
    const regA = await api("POST", "/api/registers", { name: "Offline Drawer A" });
    assert.equal(regA.status, 201);
    registerA = regA.json.data.id;
  });

  function saleOpPayload(
    key: string,
    variant: number,
    quantity: number,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      sale: {
        saleDate: new Date().toISOString(),
        customerId: null,
        payments: [
          { method: "cash", amount: 60 * quantity, tendered: 60 * quantity },
        ],
        discount: null,
        vatPercent: 0,
        idempotencyKey: key,
        items: [{ variantId: variant, quantity, unitPrice: 60, discount: null }],
        ...overrides,
      },
    };
  }

  async function syncOps(
    terminal: number,
    ops: unknown[],
  ): Promise<{ status: number; results: any[] }> {
    const res = await api(
      "POST",
      "/api/offline/sync",
      { ops },
      { "X-Terminal-Id": String(terminal) },
    );
    return { status: res.status, results: res.json?.data?.results ?? [] };
  }

  it("requires a bound terminal for offline access", async () => {
    const unbound = await api("GET", "/api/offline/session");
    assert.equal(unbound.status, 400);
    const bound = await api("GET", "/api/offline/session", undefined, {
      "X-Terminal-Id": String(terminalA),
    });
    assert.equal(bound.status, 200);
    assert.equal(bound.json.data.policies.offlineAllocationTtlHours, 24);
  });

  it("grants disjoint allowances to two offline terminals", async () => {
    const grantA = await api(
      "POST",
      "/api/offline/allocations",
      { variantIds: [allocatedVariantId] },
      { "X-Terminal-Id": String(terminalA) },
    );
    assert.equal(grantA.status, 200);
    const a = grantA.json.data.find((x: any) => x.variantId === allocatedVariantId);
    assert.equal(a.allocatedQty, 10, JSON.stringify(grantA.json.data));

    // Terminal B's grant must SUBTRACT A's active allowance — the same units
    // can never be promised to two disconnected terminals.
    const grantB = await api(
      "POST",
      "/api/offline/allocations",
      { variantIds: [allocatedVariantId] },
      { "X-Terminal-Id": String(terminalB) },
    );
    const b = grantB.json.data.find((x: any) => x.variantId === allocatedVariantId);
    assert.equal(b.allocatedQty, 0);

    // A re-grant keeps its full allowance (B's 0 doesn't reduce A).
    const grantA2 = await api(
      "POST",
      "/api/offline/allocations",
      { variantIds: [allocatedVariantId] },
      { "X-Terminal-Id": String(terminalA) },
    );
    const a2 = grantA2.json.data.find((x: any) => x.variantId === allocatedVariantId);
    assert.equal(a2.allocatedQty, 10);
  });

  it("blocks serial-tracked products from offline sale (hard rule)", async () => {
    const res = await syncOps(terminalA, [
      {
        opId: `off-serial-${Date.now()}`,
        type: "sale.create",
        payload: saleOpPayload(`off-serial-${Date.now()}`, serialVariantId, 1),
      },
    ]);
    assert.equal(res.results[0].status, "failed");
    assert.match(res.results[0].error, /serial/i);
  });

  it("applies an offline sale, consumes the allocation, flags overages", async () => {
    const key = `off-sale-${Date.now()}`;
    const res = await syncOps(terminalA, [
      { opId: key, type: "sale.create", payload: saleOpPayload(key, allocatedVariantId, 6) },
    ]);
    assert.equal(res.results[0].status, "applied", JSON.stringify(res.results));

    const saleRow = await dbClient.query(
      `SELECT channel, terminal_id FROM sales WHERE idempotency_key = $1`,
      [key],
    );
    assert.equal(saleRow.rows[0].channel, "offline");
    assert.equal(saleRow.rows[0].terminal_id, terminalA);

    const allocation = await dbClient.query(
      `SELECT allocated_qty, consumed_qty FROM offline_allocations
       WHERE terminal_id = $1 AND variant_id = $2 AND status = 'active'`,
      [terminalA, allocatedVariantId],
    );
    assert.equal(allocation.rows[0].consumed_qty, 6);
    assert.equal(allocation.rows[0].allocated_qty, 10);
    const conflictCount = await dbClient.query(
      `SELECT count(*)::int AS n FROM sync_conflicts WHERE business_id = $1 AND status = 'open'`,
      [businessId],
    );
    assert.equal(conflictCount.rows[0].n, 0);

    // Overage: sell 6 more against a remaining allowance of 4 → applies
    // (the sale physically happened) + conflict for review.
    const overKey = `off-over-${Date.now()}`;
    const over = await syncOps(terminalA, [
      { opId: overKey, type: "sale.create", payload: saleOpPayload(overKey, allocatedVariantId, 6) },
    ]);
    assert.equal(over.results[0].status, "applied");
    assert.ok(over.results[0].conflictId, "overage surfaces a conflict record");
    const conflict = await dbClient.query(
      `SELECT reason FROM sync_conflicts WHERE id = $1`,
      [over.results[0].conflictId],
    );
    assert.equal(conflict.rows[0].reason, "allocation_exceeded");
  });

  it("accepts a bare sale payload (pre-contract outbox back-compat)", async () => {
    // Outboxes recorded before the browser client adopted the wrapped
    // { sale } contract hold the bare CreateSalePayload — those entries
    // must still sync instead of failing with "requires a sale payload".
    // Uses its own product so the shared fixtures' stock stays untouched.
    const bareVariantId = await createProduct("Off Bare", 60, 3, "none");
    await dbClient.query(`UPDATE products SET offline_policy = 'open' WHERE name = 'Off Bare'`);

    const key = `off-bare-${Date.now()}`;
    const res = await syncOps(terminalB, [
      {
        opId: key,
        type: "sale.create",
        payload: saleOpPayload(key, bareVariantId, 1).sale,
      },
    ]);
    assert.equal(res.results[0].status, "applied", JSON.stringify(res.results));
    const saleRow = await dbClient.query(
      `SELECT id FROM sales WHERE idempotency_key = $1`,
      [key],
    );
    assert.equal(saleRow.rows.length, 1);
    const stock = await dbClient.query(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [bareVariantId, businessId],
    );
    assert.equal(Number(stock.rows[0].quantity), 2);
  });

  it("open mode: selling beyond stock applies with negative stock + conflict", async () => {
    // Stock is 2; terminal B has no allocation gate on 'open' products.
    const grantB = await api(
      "POST",
      "/api/offline/allocations",
      { variantIds: [openVariantId] },
      { "X-Terminal-Id": String(terminalB) },
    );
    const b = grantB.json.data.find((x: any) => x.variantId === openVariantId);
    assert.equal(b.policy, "open");

    const key = `off-open-${Date.now()}`;
    const res = await syncOps(terminalB, [
      { opId: key, type: "sale.create", payload: saleOpPayload(key, openVariantId, 5) },
    ]);
    assert.equal(res.results[0].status, "applied", JSON.stringify(res.results));
    const stock = await dbClient.query(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [openVariantId, businessId],
    );
    assert.equal(Number(stock.rows[0].quantity), -3);
    const conflict = await dbClient.query(
      `SELECT reason, status FROM sync_conflicts
       WHERE business_id = $1 AND op_id = $2 AND reason = 'negative_stock_open_mode'`,
      [businessId, key],
    );
    assert.equal(conflict.rows.length, 1);
    assert.equal(conflict.rows[0].status, "open");
  });

  it("offline sale replays are idempotent", async () => {
    const key = `off-replay-${Date.now()}`;
    const op = { opId: key, type: "sale.create", payload: saleOpPayload(key, allocatedVariantId, 1) };
    const first = await syncOps(terminalA, [op]);
    assert.equal(first.results[0].status, "applied");
    const stockAfterFirst = await dbClient.query(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [allocatedVariantId, businessId],
    );
    const replay = await syncOps(terminalA, [op]);
    assert.equal(replay.results[0].status, "applied");
    const stockAfterReplay = await dbClient.query(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [allocatedVariantId, businessId],
    );
    assert.equal(
      Number(stockAfterReplay.rows[0].quantity),
      Number(stockAfterFirst.rows[0].quantity),
    );
  });

  it("offline customer.create adopts the client UUID idempotently", async () => {
    const clientUuid = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const op = {
      opId: `off-cust-${Date.now()}`,
      type: "customer.create",
      payload: { clientUuid, name: "Offline Created", phone: "1766000055" },
    };
    const first = await syncOps(terminalA, [op]);
    assert.equal(first.results[0].status, "applied");
    const replay = await syncOps(terminalA, [op]);
    assert.equal(replay.results[0].status, "duplicate");
    assert.equal(replay.results[0].customerId, first.results[0].customerId);
  });

  it("offline drawer: open, movement, close — all replay-safe", async () => {
    // Run-unique: the shared ezpos_test keeps rows from earlier runs.
    const sessionId = `a1b2c3d4-0000-4000-8000-${String(Date.now()).slice(-12).padStart(12, "0")}`;
    const openOp = {
      opId: `off-dopen-${Date.now()}`,
      type: "drawer.open",
      payload: { clientSessionId: sessionId, registerId: registerA, openingCash: 500 },
    };
    const open = await syncOps(terminalA, [openOp]);
    assert.equal(open.results[0].status, "applied", JSON.stringify(open.results));
    const sessionRow = await dbClient.query(
      `SELECT terminal_id, user_id FROM register_sessions WHERE client_session_id = $1`,
      [sessionId],
    );
    assert.equal(sessionRow.rows[0].terminal_id, terminalA);

    const openReplay = await syncOps(terminalA, [openOp]);
    assert.equal(openReplay.results[0].status, "duplicate");

    const moveOpId = `off-dmove-${Date.now()}`;
    const move = await syncOps(terminalA, [
      {
        opId: moveOpId,
        type: "drawer.movement",
        payload: { clientSessionId: sessionId, clientOpId: moveOpId, type: "cash_in", amount: 200 },
      },
    ]);
    assert.equal(move.results[0].status, "applied", JSON.stringify(move.results));
    const moveReplay = await syncOps(terminalA, [
      {
        opId: `${moveOpId}-replay`,
        type: "drawer.movement",
        payload: { clientSessionId: sessionId, clientOpId: moveOpId, type: "cash_in", amount: 200 },
      },
    ]);
    assert.equal(moveReplay.results[0].status, "duplicate");
    const movements = await dbClient.query(
      `SELECT count(*)::int AS n FROM register_transactions WHERE client_op_id = $1`,
      [moveOpId],
    );
    assert.equal(movements.rows[0].n, 1);

    const close = await syncOps(terminalA, [
      {
        opId: `off-dclose-${Date.now()}`,
        type: "drawer.close",
        payload: { clientSessionId: sessionId, countedCash: 700 },
      },
    ]);
    assert.equal(close.results[0].status, "applied", JSON.stringify(close.results));
    const closed = await dbClient.query(
      `SELECT status, difference FROM register_sessions WHERE client_session_id = $1`,
      [sessionId],
    );
    assert.equal(closed.rows[0].status, "closed");
    assert.equal(Number(closed.rows[0].difference), 0); // 500 + 200 = 700
  });

  it("conflict review: manager lists and resolves", async () => {
    const list = await api("GET", "/api/offline/conflicts");
    assert.equal(list.status, 200);
    const open = list.json.data.filter((c: any) => c.status === "open");
    assert.ok(open.length >= 2);

    const target = open[0];
    const resolve = await api(
      "POST",
      `/api/offline/conflicts/${target.id}/resolve`,
      { action: "discard" },
    );
    assert.equal(resolve.status, 200);
    const after = await dbClient.query(
      `SELECT status FROM sync_conflicts WHERE id = $1`,
      [target.id],
    );
    assert.equal(after.rows[0].status, "resolved_discarded");
  });
});
