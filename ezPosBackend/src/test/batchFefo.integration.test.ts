/**
 * P3 Phase 2: batch management + FEFO at the POS register — the acceptance
 * matrix from the approved plan (§F.8): FEFO ordering with NULL expiry last
 * and expired exclusion, manual selection precedence + D9 no-top-up,
 * expired-batch policy (block / allow_with_approval + manager approval),
 * provenance-restoring returns (original batches, RETURN- only as fallback),
 * concurrent batch sales, offline expired-selection conflict, transfers
 * FEFO alignment, non-batch behavior unchanged. Against a REAL PostgreSQL
 * database. Double-guarded like the other suites.
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

describe("batchFefo integration", { skip: !runIntegration }, () => {
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
  const uniqueEmail = () => `bfe-${Date.now()}-${(counter += 1)}@example.test`;

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

  async function dbQuery(sql: string, params: unknown[] = []): Promise<any[]> {
    const rows = await pg!.query(sql, params);
    return rows.rows;
  }

  function payload<T>(res: { body: unknown }): T {
    return (res.body as { data: T }).data;
  }

  let owner: Ctx;
  let locationId = 0;
  let secondLocationId = 0;
  let batchVariantId = 0;
  let plainVariantId = 0;

  /** Live quantityRemaining of a batch by batchNumber. */
  async function batchQty(batchNumber: string): Promise<number> {
    const rows = await dbQuery(
      "SELECT quantity_remaining FROM inventory_batches WHERE batch_number = $1 AND business_id = $2",
      [batchNumber, owner.businessId],
    );
    return Number(rows[0]!.quantity_remaining);
  }

  /** Per-batch consumption for a sale. */
  async function saleConsumption(
    saleId: number,
  ): Promise<{ batchId: number; quantity: number }[]> {
    const rows = await dbQuery(
      `SELECT c.batch_id, c.quantity FROM sale_item_batch_consumptions c
       WHERE c.sale_id = $1 ORDER BY c.batch_id`,
      [saleId],
    );
    return rows.map((r) => ({ batchId: Number(r.batch_id), quantity: Number(r.quantity) }));
  }

  async function createSale(
    items: { variantId: number; quantity: number; unitPrice?: number; batchId?: number }[],
    overrides: Record<string, unknown> = {},
  ): Promise<{ status: number; body: any }> {
    return api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [
        {
          method: "cash",
          amount: items.reduce(
            (s, i) => s + (i.unitPrice ?? 10) * i.quantity,
            0,
          ),
          tendered: items.reduce(
            (s, i) => s + (i.unitPrice ?? 10) * i.quantity,
            0,
          ),
        },
      ],
      discount: null,
      vatPercent: 0,
      items: items.map((i) => ({
        variantId: i.variantId,
        quantity: i.quantity,
        unitPrice: i.unitPrice ?? 10,
        discount: null,
        ...(i.batchId !== undefined ? { batchId: i.batchId } : {}),
      })),
      ...overrides,
    });
  }

  before(async () => {
    const ownerEmail = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "FEFO Owner",
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
      name: `FEFO Co ${stamp}`,
    });
    assert.equal(biz.status, 201);
    owner.businessId = biz.body.business.id;

    const locRes = await api(owner, "POST", "/api/locations", {
      name: `FEFO Main ${stamp}`,
    });
    assert.equal(locRes.status, 201);
    locationId = payload<{ id: number }>(locRes).id;
    const loc2 = await api(owner, "POST", "/api/locations", {
      name: `FEFO Second ${stamp}`,
    });
    assert.equal(loc2.status, 201);
    secondLocationId = payload<{ id: number }>(loc2).id;

    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `FEFO Piece ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ value: number }>(unitRes).value;

    // Batch-tracked product (opening stock empty — batches are inserted
    // directly below with controlled expiry dates).
    const product = await api(owner, "POST", "/api/product", {
      name: `FEFO Milk ${stamp}`,
      categoryId: null,
      brandId: null,
      unitId,
      description: "",
      productType: "physical",
      hasVariants: false,
      trackingType: "batch",
      supplierId: null,
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "opening",
      variants: [
        {
          sku: `FEFO-${stamp}`,
          barcode: null,
          sellingPrice: 10,
          alertQuantity: 1,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `OPEN-${stamp}`,
          purchasePrice: 4,
          quantity: 5,
          expiryDate: null,
        },
      ],
    });
    assert.equal(product.status, 201, JSON.stringify(product.body));
    const list = await api(owner, "GET", "/api/products");
    const created = (
      list.body as { name: string; variants: { id: number }[] }[]
    ).find((p) => p.name === `FEFO Milk ${stamp}`);
    assert.ok(created);
    batchVariantId = created.variants[0]!.id;

    // Non-batch control product.
    const plain = await api(owner, "POST", "/api/product", {
      name: `FEFO Plain ${stamp}`,
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
          sku: `FPLN-${stamp}`,
          barcode: null,
          sellingPrice: 10,
          alertQuantity: 1,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `FPLNB-${stamp}`,
          purchasePrice: 4,
          quantity: 50,
          expiryDate: null,
        },
      ],
    });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    const plainList = await api(owner, "GET", "/api/products");
    const plainCreated = (
      plainList.body as { name: string; variants: { id: number }[] }[]
    ).find((p) => p.name === `FEFO Plain ${stamp}`);
    assert.ok(plainCreated);
    plainVariantId = plainCreated.variants[0]!.id;

    // Controlled batches: the EXPIRED batch is inserted FIRST (lowest id) so
    // id-based FIFO would pick it — proving FEFO ordering is expiry-driven.
    const day = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    await dbQuery(
      `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining, expiry_date)
       VALUES ($1, $2, $3, 'B-EXPIRED', 4, 5, 5, $4)`,
      [owner.businessId, batchVariantId, locationId, day(-1)],
    );
    await dbQuery(
      `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining, expiry_date)
       VALUES ($1, $2, $3, 'B-10D', 4, 5, 5, $4)`,
      [owner.businessId, batchVariantId, locationId, day(10)],
    );
    await dbQuery(
      `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining, expiry_date)
       VALUES ($1, $2, $3, 'B-30D', 4, 5, 5, $4)`,
      [owner.businessId, batchVariantId, locationId, day(30)],
    );
    await dbQuery(
      `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining, expiry_date)
       VALUES ($1, $2, $3, 'B-NULL', 4, 5, 5, NULL)`,
      [owner.businessId, batchVariantId, locationId],
    );
    // Variant-level stock the validator reads (opening 5 + direct batches 20).
    await dbQuery(
      `INSERT INTO inventory_stock (business_id, variant_id, location_id, quantity)
       VALUES ($1, $2, $3, 20)
       ON CONFLICT (business_id, variant_id, location_id)
       DO UPDATE SET quantity = 20`,
      [owner.businessId, batchVariantId, locationId],
    );
  });

  it("the batch picker lists batches FEFO with expiry status, hiding expired under 'block'", async () => {
    const res = await api(
      owner,
      "GET",
      `/api/variants/${batchVariantId}/batches`,
    );
    assert.equal(res.status, 200);
    const batches = payload<
      { id: number; batchNumber: string; quantityRemaining: number; expiryStatus: string }[]
    >(res);
    const numbers = batches.map((b) => b.batchNumber);
    // FEFO: earliest valid expiry first, NULLS LAST (the OPEN- batch sits
    // with B-NULL among the never-expiring rows, id order); expired hidden.
    assert.deepEqual(numbers.slice(0, 2), ["B-10D", "B-30D"]);
    assert.ok(!numbers.includes("B-EXPIRED"), `got ${numbers}`);
    const nullTail = numbers.slice(2);
    assert.equal(nullTail.length, 2);
    assert.ok(nullTail.every((n) => n === "B-NULL" || n.startsWith("OPEN-")));
    assert.equal(batches[0]!.expiryStatus, "expiring_soon");
    assert.ok(batches.slice(2).every((b) => b.expiryStatus === "no_expiry"));
  });

  it("FEFO consumption takes the earliest valid expiry first and never expired stock", async () => {
    const sale = await createSale([{ variantId: batchVariantId, quantity: 6 }]);
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const saleId = sale.body.data.sale.id as number;
    const consumed = await saleConsumption(saleId);
    // 6 units: B-10D fully (5) + B-30D (1) — NOT the expired batch (lowest
    // id) and NOT the NULL-expiry batch.
    assert.deepEqual(consumed, [
      { batchId: consumed[0]!.batchId, quantity: 5 },
      { batchId: consumed[1]!.batchId, quantity: 1 },
    ]);
    const tenD = await dbQuery(
      "SELECT id FROM inventory_batches WHERE batch_number = 'B-10D' AND business_id = $1",
      [owner.businessId],
    );
    assert.equal(consumed[0]!.batchId, tenD[0]!.id);
    assert.equal(await batchQty("B-10D"), 0);
    assert.equal(await batchQty("B-30D"), 4);
    assert.equal(await batchQty("B-EXPIRED"), 5); // untouched
    assert.equal(await batchQty("B-NULL"), 5); // untouched
    // Last sale id retained for the provenance-return test.
    (globalThis as any).__fefoSaleId = saleId;
  });

  it("manual batch selection takes precedence and consumes only that batch", async () => {
    const thirty = await dbQuery(
      "SELECT id FROM inventory_batches WHERE batch_number = 'B-30D' AND business_id = $1",
      [owner.businessId],
    );
    const sale = await createSale([
      { variantId: batchVariantId, quantity: 2, batchId: thirty[0]!.id },
    ]);
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const consumed = await saleConsumption(sale.body.data.sale.id);
    assert.equal(consumed.length, 1);
    assert.equal(consumed[0]!.batchId, thirty[0]!.id);
    assert.equal(consumed[0]!.quantity, 2);
    assert.equal(await batchQty("B-30D"), 2);
  });

  it("a manual selection short by more units is REJECTED, never FEFO-topped-up (D9)", async () => {
    const thirty = await dbQuery(
      "SELECT id FROM inventory_batches WHERE batch_number = 'B-30D' AND business_id = $1",
      [owner.businessId],
    );
    const sale = await createSale([
      { variantId: batchVariantId, quantity: 10, batchId: thirty[0]!.id },
    ]);
    assert.equal(sale.status, 409, JSON.stringify(sale.body));
    assert.match(sale.body.message, /Batch B-30D has \d+ of the 10 unit\(s\)/);
    // No partial consumption leaked.
    assert.equal(await batchQty("B-30D"), 2);
  });

  it("an expired batch cannot be sold under the default 'block' policy", async () => {
    const expired = await dbQuery(
      "SELECT id FROM inventory_batches WHERE batch_number = 'B-EXPIRED' AND business_id = $1",
      [owner.businessId],
    );
    const sale = await createSale([
      { variantId: batchVariantId, quantity: 1, batchId: expired[0]!.id },
    ]);
    assert.equal(sale.status, 409, JSON.stringify(sale.body));
    assert.match(sale.body.message, /Expired batch B-EXPIRED cannot be sold/);
    assert.equal(await batchQty("B-EXPIRED"), 5);
  });

  it("'allow_with_approval' gates expired selection behind a one-time manager approval", async () => {
    const patch = await api(owner, "PATCH", "/api/pos-settings", {
      expiredBatchPolicy: "allow_with_approval",
    });
    assert.equal(patch.status, 200);
    const expired = await dbQuery(
      "SELECT id FROM inventory_batches WHERE batch_number = 'B-EXPIRED' AND business_id = $1",
      [owner.businessId],
    );
    const batchId = expired[0]!.id;

    // Without a token: rejected with the approval demand.
    const noToken = await createSale([
      { variantId: batchVariantId, quantity: 1, batchId },
    ]);
    assert.equal(noToken.status, 403, JSON.stringify(noToken.body));
    assert.match(noToken.body.message, /manager approval is required/);

    // Mint a token (owner holds inventory.adjust — the op's authority).
    await api(owner, "POST", "/api/manager-approval/pin", { pin: "246810" });
    const verify = await api(owner, "POST", "/api/manager-approval/verify", {
      pin: "246810",
      opType: "sale.expired_batch",
      reason: "customer pre-ordered, batch expired this morning",
    });
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    const approvalToken = payload<{ approvalToken: string }>(verify).approvalToken;

    const sale = await createSale(
      [{ variantId: batchVariantId, quantity: 1, batchId }],
      { approvalToken },
    );
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const consumed = await saleConsumption(sale.body.data.sale.id);
    assert.equal(consumed[0]!.batchId, batchId);
    assert.equal(await batchQty("B-EXPIRED"), 4);

    // The token was consumed — a retry with the same token is rejected as a
    // conflict (consumed approval tokens are 409, not 403).
    const replay = await createSale(
      [{ variantId: batchVariantId, quantity: 1, batchId }],
      { approvalToken },
    );
    assert.equal(replay.status, 409, JSON.stringify(replay.body));

    // Restore the default policy.
    const restore = await api(owner, "PATCH", "/api/pos-settings", {
      expiredBatchPolicy: "block",
    });
    assert.equal(restore.status, 200);
  });

  it("a partial return restores the ORIGINAL batches (provenance), RETURN- only as fallback", async () => {
    const saleId = (globalThis as any).__fefoSaleId as number;
    assert.ok(saleId, "FEFO sale from the earlier test");
    // Consumption was B-10D 5 + B-30D 1. Return 3 → B-10D gets all 3
    // (largest consumption first). refunds_all defaults to a FULL return,
    // so the partial case names the line quantity explicitly.
    const itemRows = await dbQuery(
      "SELECT id FROM sale_items WHERE sale_id = $1",
      [saleId],
    );
    const refund = await api(
      owner,
      "POST",
      `/api/sold_products/refunds_all/${saleId}`,
      {
        reason: "customer_request",
        disposition: "restock",
        refundMethod: "cash",
        quantities: [{ saleItemId: itemRows[0]!.id, quantity: 3 }],
      },
    );
    assert.equal(refund.status, 200, JSON.stringify(refund.body));
    assert.equal(await batchQty("B-10D"), 3);
    assert.equal(await batchQty("B-30D"), 2);
    const fallback = await dbQuery(
      "SELECT count(*)::int AS n FROM inventory_batches WHERE batch_number LIKE 'RETURN-%' AND business_id = $1",
      [owner.businessId],
    );
    assert.equal(fallback[0]!.n, 0);

    // Full return of the remaining 3 units → both lots back to 5.
    const refund2 = await api(
      owner,
      "POST",
      `/api/sold_products/refunds_all/${saleId}`,
      {
        reason: "customer_request",
        disposition: "restock",
        refundMethod: "cash",
        quantities: [{ saleItemId: itemRows[0]!.id, quantity: 3 }],
      },
    );
    assert.equal(refund2.status, 200, JSON.stringify(refund2.body));
    assert.equal(await batchQty("B-10D"), 5);
    // B-30D was never fully drained: FEFO took 1 + manual took 2 → the full
    // return restores its last outstanding unit → 3.
    assert.equal(await batchQty("B-30D"), 3);
    const fallback2 = await dbQuery(
      "SELECT count(*)::int AS n FROM inventory_batches WHERE batch_number LIKE 'RETURN-%' AND business_id = $1",
      [owner.businessId],
    );
    assert.equal(fallback2[0]!.n, 0);
  });

  it("concurrent manual-batch sales cannot oversell the selected batch", async () => {
    const day = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    await dbQuery(
      `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining, expiry_date)
       VALUES ($1, $2, $3, 'B-RACE', 4, 5, 5, $4)`,
      [owner.businessId, batchVariantId, locationId, day(60)],
    );
    await dbQuery(
      "UPDATE inventory_stock SET quantity = quantity + 10 WHERE business_id = $1 AND variant_id = $2 AND location_id = $3",
      [owner.businessId, batchVariantId, locationId],
    );
    const race = await dbQuery(
      "SELECT id FROM inventory_batches WHERE batch_number = 'B-RACE' AND business_id = $1",
      [owner.businessId],
    );
    const results = await Promise.allSettled([
      createSale([
        { variantId: batchVariantId, quantity: 5, batchId: race[0]!.id },
      ]),
      createSale([
        { variantId: batchVariantId, quantity: 5, batchId: race[0]!.id },
      ]),
    ]);
    const statuses = results.map((r) =>
      r.status === "fulfilled" ? r.value.status : 0,
    );
    const bodies = results.map((r) =>
      r.status === "fulfilled" ? r.value.body : String(r.reason),
    );
    assert.equal(statuses.filter((s) => s === 201).length, 1, JSON.stringify(bodies));
    assert.equal(statuses.filter((s) => s === 409).length, 1, JSON.stringify(bodies));
    // Exactly 5 consumed from the winning sale.
    assert.equal(await batchQty("B-RACE"), 0);
  });

  it("offline sync flags an expired selection as an expired_batch_selected conflict and applies nothing", async () => {
    const expired = await dbQuery(
      "SELECT id FROM inventory_batches WHERE batch_number = 'B-EXPIRED' AND business_id = $1",
      [owner.businessId],
    );
    const terminalId = (
      await dbQuery(
        `INSERT INTO pos_terminals (business_id, location_id, name) VALUES ($1, $2, 'FEFO Offline Counter') RETURNING id`,
        [owner.businessId, locationId],
      )
    )[0].id;
    const key = `fefo-offline-${Date.now()}`;
    const op = {
      opId: key,
      type: "sale.create",
      payload: {
        sale: {
          saleDate: new Date().toISOString(),
          customerId: null,
          payments: [{ method: "cash", amount: 10, tendered: 10 }],
          discount: null,
          vatPercent: 0,
          idempotencyKey: key,
          items: [
            {
              variantId: batchVariantId,
              quantity: 1,
              unitPrice: 10,
              discount: null,
              batchId: expired[0]!.id,
            },
          ],
        },
      },
    };
    const sync = await api(
      owner,
      "POST",
      "/api/offline/sync",
      { ops: [op] },
      { "X-Terminal-Id": String(terminalId) },
    );
    assert.equal(sync.status, 200, JSON.stringify(sync.body));
    assert.equal(sync.body.data.results[0].status, "failed");
    const conflicts = await dbQuery(
      "SELECT reason FROM sync_conflicts WHERE op_id = $1",
      [key],
    );
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.reason, "expired_batch_selected");
    // The sale was NOT applied.
    const sales = await dbQuery(
      "SELECT count(*)::int AS n FROM sales WHERE idempotency_key = $1",
      [key],
    );
    assert.equal(sales[0]!.n, 0);
    assert.equal(await batchQty("B-EXPIRED"), 4);
  });

  it("non-batch products keep single-batch consumption unchanged", async () => {
    const sale = await createSale([{ variantId: plainVariantId, quantity: 2 }]);
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const consumed = await saleConsumption(sale.body.data.sale.id);
    // One opening-stock batch covers the line (id-order, no expiry).
    assert.equal(consumed.length, 1);
    const batch = await dbQuery(
      "SELECT batch_number, expiry_date FROM inventory_batches WHERE id = $1",
      [consumed[0]!.batchId],
    );
    assert.match(batch[0]!.batch_number, /^FPLNB-/);
    assert.equal(batch[0]!.expiry_date, null);
  });

  it("stock transfers consume FEFO at the source and never ship expired stock", async () => {
    // Batches now: B-10D 5, B-30D 5, B-NULL 5, B-EXPIRED 4 (all at Main).
    const create = await api(owner, "POST", "/api/stock-transfers", {
      fromLocationId: locationId,
      toLocationId: secondLocationId,
      items: [{ variantId: batchVariantId, quantity: 2 }],
    });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const transferId = payload<{ id: number }>(create).id;
    const authorize = await api(
      owner,
      "POST",
      `/api/stock-transfers/${transferId}/authorize`,
      {},
    );
    assert.equal(authorize.status, 200, JSON.stringify(authorize.body));
    const ship = await api(
      owner,
      "POST",
      `/api/stock-transfers/${transferId}/ship`,
      {},
    );
    assert.equal(ship.status, 200, JSON.stringify(ship.body));
    // The two shipped units came from B-10D (earliest expiry), not B-EXPIRED.
    assert.equal(await batchQty("B-10D"), 3);
    assert.equal(await batchQty("B-EXPIRED"), 4);
  });
});
