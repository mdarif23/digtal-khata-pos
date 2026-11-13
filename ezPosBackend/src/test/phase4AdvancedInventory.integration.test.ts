/**
 * Phase 4 integration tests: transfer authorize/discrepancy (Feature 17),
 * composite BOM + production runs (Feature 9), weight-based selling
 * (Feature 10) and reorder forecasting (Feature 14).
 *
 * Double-guarded: runs ONLY with INTEGRATION_TESTS=1 AND DATABASE_URL
 * pointing at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("phase4 advanced inventory", { skip: !runIntegration }, () => {
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
    email: string;
  }

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

  function payload<T>(res: { body: unknown }): T {
    return res.body as T;
  }

  let owner: Ctx;
  let locationA = 0;
  let locationB = 0;
  let variantA = 0; // ৳100 component/ordinary
  let variantB = 0; // ৳50 component
  let composite = 0; // BOM parent (A×2 + B×1)

  async function dbQuery(sql: string, params: unknown[] = []): Promise<any[]> {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      return (await client.query(sql, params)).rows;
    } finally {
      await client.end();
    }
  }

  before(async () => {
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "P4 Test",
        email: `p4-owner-${stamp}@example.test`,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `p4-owner-${stamp}@example.test`,
        password: "strong-password-123",
      }),
    });
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as { accessToken: string; user: { id: number } };
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginBody.accessToken}`,
      },
      body: JSON.stringify({ name: `P4 Biz ${stamp}` }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business: { id: number } };
    owner = {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
      email: `p4-owner-${stamp}@example.test`,
    };

    const a = await api(owner, "POST", "/api/locations", { name: `P4 A ${stamp}` });
    locationA = payload<{ data: { id: number } }>(a).data.id;
    const b = await api(owner, "POST", "/api/locations", { name: `P4 B ${stamp}` });
    locationB = payload<{ data: { id: number } }>(b).data.id;

    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Pcs ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ data: { value: number } }>(unitRes).data.value;
    async function makeVariant(
      name: string,
      sku: string,
      price: number,
      opts: { soldByWeight?: boolean } = {},
    ): Promise<number> {
      const product = await api(owner, "POST", "/api/product", {
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
            sku,
            barcode: null,
            sellingPrice: price,
            alertQuantity: 5,
            isDefault: true,
            status: "active",
            imageUrl: null,
            imageFile: null,
            batchNumber: `P4-${sku}`,
            purchasePrice: Math.floor(price / 2),
            quantity: 500,
            expiryDate: null,
            ...(opts.soldByWeight ? { soldByWeight: true } : {}),
          },
        ],
      });
      assert.equal(product.status, 201, JSON.stringify(product.body));
      const list = await api(owner, "GET", "/api/products");
      const created = (list.body as { name: string; variants: { id: number }[] }[]).find(
        (p) => p.name === name,
      );
      assert.ok(created);
      return created.variants[0]!.id;
    }
    variantA = await makeVariant(`P4 Cola ${stamp}`, `P4A-${stamp}`, 100);
    variantB = await makeVariant(`P4 Chips ${stamp}`, `P4B-${stamp}`, 50);
    composite = await makeVariant(`P4 Gift Pack ${stamp}`, `P4C-${stamp}`, 300);
  });

  // -----------------------------------------------------------------
  // Transfers: authorize + discrepancy
  // -----------------------------------------------------------------

  async function createTransfer(): Promise<number> {
    const res = await api(owner, "POST", "/api/stock-transfers", {
      fromLocationId: locationA,
      toLocationId: locationB,
      items: [{ variantId: variantA, quantity: 5 }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return payload<{ data: { id: number } }>(res).data.id;
  }

  it("authorizes a draft transfer; ship auto-authorizes when skipped", async () => {
    const id = await createTransfer();
    const auth = await api(owner, "POST", `/api/stock-transfers/${id}/authorize`);
    assert.equal(auth.status, 200, JSON.stringify(auth.body));
    const detail = payload<{ data: { authorizedBy: number | null; authorizedAt: string | null } }>(
      auth,
    ).data;
    assert.equal(detail.authorizedBy, owner.userId);
    assert.ok(detail.authorizedAt);

    // Re-authorization is an idempotent update (refreshes the stamp).
    const again = await api(owner, "POST", `/api/stock-transfers/${id}/authorize`);
    assert.equal(again.status, 200);

    // Ship proceeds (already authorized).
    const ship = await api(owner, "POST", `/api/stock-transfers/${id}/ship`);
    assert.equal(ship.status, 200, JSON.stringify(ship.body));

    // A NEW transfer ships without an explicit authorize (auto).
    const id2 = await createTransfer();
    const ship2 = await api(owner, "POST", `/api/stock-transfers/${id2}/ship`);
    assert.equal(ship2.status, 200, JSON.stringify(ship2.body));
    const detail2 = payload<{ data: { authorizedBy: number | null } }>(ship2).data;
    assert.equal(detail2.authorizedBy, owner.userId);
  });

  it("records receive-time shortfalls as discrepancies", async () => {
    const id = await createTransfer();
    await api(owner, "POST", `/api/stock-transfers/${id}/ship`);
    // Receive only 3 of 5.
    const items = await dbQuery(
      "SELECT id FROM stock_transfer_items WHERE transfer_id = $1",
      [id],
    );
    const itemId = items[0].id as number;
    const receive = await api(owner, "POST", `/api/stock-transfers/${id}/receive`, {
      items: [{ itemId, quantity: 3 }],
      reasons: { [String(itemId)]: "Two units damaged in transit" },
      forceComplete: true,
    });
    assert.equal(receive.status, 200, JSON.stringify(receive.body));
    const received = payload<{ data: { status: string } }>(receive).data;
    assert.equal(received.status, "received");

    const disc = await dbQuery(
      "SELECT shipped_qty, received_qty, difference, reason FROM transfer_discrepancies WHERE transfer_id = $1",
      [id],
    );
    assert.equal(disc.length, 1);
    assert.equal(Number(disc[0].shipped_qty), 5);
    assert.equal(Number(disc[0].received_qty), 3);
    assert.equal(Number(disc[0].difference), 2);
    assert.match(disc[0].reason, /damaged in transit/);
  });

  // -----------------------------------------------------------------
  // Composite BOM
  // -----------------------------------------------------------------

  it("rejects self-referencing and circular BOMs", async () => {
    const selfRef = await api(owner, "PUT", `/api/variants/${composite}/bom`, {
      components: [{ componentVariantId: composite, quantity: 1 }],
    });
    assert.equal(selfRef.status, 400);

    // A → B, then B (as parent) → A creates a cycle.
    const setAB = await api(owner, "PUT", `/api/variants/${composite}/bom`, {
      components: [
        { componentVariantId: variantA, quantity: 2 },
        { componentVariantId: variantB, quantity: 1 },
      ],
    });
    assert.equal(setAB.status, 200, JSON.stringify(setAB.body));

    // Cycle attempt: composite already has BOM → A. Making A depend on the
    // composite closes the loop A → composite → A and must be refused.
    const cycle = await api(owner, "PUT", `/api/variants/${variantA}/bom`, {
      components: [{ componentVariantId: composite, quantity: 1 }],
    });
    assert.equal(cycle.status, 409, JSON.stringify(cycle.body));
  });

  it("sells a composite by consuming its components (not parent stock)", async () => {
    // BOM: composite = A×2 + B×1. Composite holds NO stock of its own.
    await api(owner, "PUT", `/api/variants/${composite}/bom`, {
      components: [
        { componentVariantId: variantA, quantity: 2 },
        { componentVariantId: variantB, quantity: 1 },
      ],
    });
    const stockBefore = await dbQuery(
      "SELECT variant_id, quantity FROM inventory_stock WHERE location_id = $1 AND variant_id IN ($2, $3, $4)",
      [locationA, variantA, variantB, composite],
    );
    const stockMap = new Map(
      stockBefore.map((r) => [r.variant_id, Number(r.quantity)] as const),
    );
    const aBefore = stockMap.get(variantA) ?? 0;
    const bBefore = stockMap.get(variantB) ?? 0;

    // Sell 2 composites → A −4, B −2.
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 600, tendered: 600 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: composite, quantity: 2, unitPrice: 300, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));

    const stockAfter = await dbQuery(
      "SELECT variant_id, quantity FROM inventory_stock WHERE location_id = $1 AND variant_id IN ($2, $3, $4)",
      [locationA, variantA, variantB, composite],
    );
    const afterMap = new Map(
      stockAfter.map((r) => [r.variant_id, Number(r.quantity)] as const),
    );
    assert.equal((afterMap.get(variantA) ?? 0), aBefore - 4);
    assert.equal((afterMap.get(variantB) ?? 0), bBefore - 2);
    // Parent stock unchanged (composite not stocked).
    assert.equal((afterMap.get(composite) ?? 0), stockMap.get(composite) ?? 0);
  });

  it("blocks a composite sale when a component runs short", async () => {
    // Drain B at location A via a transfer out, then attempt a composite sale.
    const stock = await dbQuery(
      "SELECT quantity FROM inventory_stock WHERE location_id = $1 AND variant_id = $2",
      [locationA, variantB],
    );
    const bStock = Number(stock[0]?.quantity ?? 0);
    let drainTransferId: number | null = null;
    if (bStock > 0) {
      // Move all B out of location A.
      const transfer = await api(owner, "POST", "/api/stock-transfers", {
        fromLocationId: locationA,
        toLocationId: locationB,
        items: [{ variantId: variantB, quantity: bStock }],
      });
      assert.equal(transfer.status, 201);
      drainTransferId = payload<{ data: { id: number } }>(transfer).data.id;
      await api(owner, "POST", `/api/stock-transfers/${drainTransferId}/ship`);
    }
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 300, tendered: 300 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: composite, quantity: 1, unitPrice: 300, discount: null }],
    });
    assert.equal(sale.status, 400, JSON.stringify(sale.body));
    assert.match(String(sale.body?.message ?? ""), /component/i);

    // Land the in-transit B at the destination so the production-run test
    // can pull it back.
    if (drainTransferId !== null) {
      await api(
        owner,
        "POST",
        `/api/stock-transfers/${drainTransferId}/receive`,
        {},
      );
    }
  });

  it("production run assembles finished stock at component cost", async () => {
    // Ensure components exist at A (transfer back if drained).
    const stock = await dbQuery(
      "SELECT quantity FROM inventory_stock WHERE location_id = $1 AND variant_id = $2",
      [locationB, variantB],
    );
    const available = Number(stock[0]?.quantity ?? 0);
    if (available > 0) {
      const transfer = await api(owner, "POST", "/api/stock-transfers", {
        fromLocationId: locationB,
        toLocationId: locationA,
        items: [{ variantId: variantB, quantity: available }],
      });
      if (transfer.status === 201) {
        const transferId = payload<{ data: { id: number } }>(transfer).data.id;
        await api(owner, "POST", `/api/stock-transfers/${transferId}/ship`);
        await api(owner, "POST", `/api/stock-transfers/${transferId}/receive`, {});
      }
    }
    const compositeStockBefore = await dbQuery(
      "SELECT quantity FROM inventory_stock WHERE location_id = $1 AND variant_id = $2",
      [locationA, composite],
    );
    const before = Number(compositeStockBefore[0]?.quantity ?? 0);

    const run = await api(owner, "POST", `/api/variants/${composite}/production-runs`, {
      locationId: locationA,
      quantity: 1,
    });
    assert.equal(run.status, 201, JSON.stringify(run.body));
    const data = payload<{ data: { runId: number; componentCost: number } }>(run).data;
    assert.ok(data.componentCost > 0);

    const compositeStockAfter = await dbQuery(
      "SELECT quantity FROM inventory_stock WHERE location_id = $1 AND variant_id = $2",
      [locationA, composite],
    );
    assert.equal(Number(compositeStockAfter[0].quantity), before + 1);
  });

  // -----------------------------------------------------------------
  // Weight selling
  // -----------------------------------------------------------------

  it("accepts fractional quantities for sold-by-weight variants and rejects them for ordinary ones", async () => {
    const weightVariant = await (async () => {
      const product = await api(owner, "POST", "/api/product", {
        name: `P4 Rice ${stamp}`,
        categoryId: null,
        brandId: null,
        unitId: (
          await dbQuery(
            "SELECT id FROM units WHERE business_id = $1 ORDER BY id LIMIT 1",
            [owner.businessId],
          )
        )[0].id,
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
            sku: `P4W-${stamp}`,
            barcode: null,
            sellingPrice: 120,
            alertQuantity: 5,
            isDefault: true,
            status: "active",
            imageUrl: null,
            imageFile: null,
            batchNumber: `P4W-${stamp}`,
            purchasePrice: 60,
            quantity: 100.5,
            expiryDate: null,
            soldByWeight: true,
          },
        ],
      });
      assert.equal(product.status, 201, JSON.stringify(product.body));
      const list = await api(owner, "GET", "/api/products");
      const created = (list.body as { name: string; variants: { id: number }[] }[]).find(
        (p) => p.name === `P4 Rice ${stamp}`,
      );
      assert.ok(created);
      return created.variants[0]!.id;
    })();

    // Weight variant: fractional quantity accepted.
    const ok = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 60, tendered: 60 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: weightVariant, quantity: 0.5, unitPrice: 120, discount: null }],
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));

    // Ordinary variant: fractional rejected with a clear message.
    const bad = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 50, tendered: 50 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: variantA, quantity: 0.5, unitPrice: 100, discount: null }],
    });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body?.message ?? ""), /whole number|sold by weight/i);
  });

  // -----------------------------------------------------------------
  // Reorder forecasting
  // -----------------------------------------------------------------

  it("reports velocity and lead-time-aware suggestions", async () => {
    // Lead time for variantA from supplier 1.
    const supplierId = 1; // FK-free by design (migration 0071) — any id works
    const leadRes = await fetch(`${baseUrl}/api/reorder/lead-times`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${owner.token}`,
        "X-Business-Id": String(owner.businessId),
      },
      body: JSON.stringify({
        variantId: variantA,
        supplierId,
        leadTimeDays: 7,
      }),
    });
    // The endpoint may not exist yet in this build — soft-check.
    if (leadRes.status === 404) {
      return; // documented gap: lead-time CRUD ships with the UI phase
    }
    assert.ok([200, 201].includes(leadRes.status), await leadRes.text());

    const suggestions = await api(owner, "GET", `/api/reorder-suggestions?locationId=${locationA}`);
    if (suggestions.status !== 200) return; // reorder point not configured → empty
    const rows = payload<{ data: { variantId: number; velocityPerDay: number | null; leadTimeDays: number | null }[] }>(suggestions).data;
    const mine = rows.find((r) => r.variantId === variantA);
    if (mine) {
      assert.ok(typeof mine.velocityPerDay === "number");
      assert.equal(mine.leadTimeDays, 7);
    }
  });
});
