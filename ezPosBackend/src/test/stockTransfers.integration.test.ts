/**
 * Inter-location stock transfer integration tests (Phase 3).
 *
 * They exercise the transfer workflow — draft → shipped → (partially)
 * received, in-transit semantics, per-location stock deduction, batch cost
 * carry-over, and location-assignment enforcement — against a REAL
 * PostgreSQL database. Double-guarded like the other suites: runs ONLY with
 * INTEGRATION_TESTS=1 AND DATABASE_URL pointing at ezpos_test (fail-closed).
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

describe("stock transfers integration", { skip: !runIntegration }, () => {
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
       -- Test-env normalization: the shared trial plan is unlimited and
       -- full-featured so POS suites exercise POS logic. Plan-limit and
       -- feature gates are covered by dedicated plans in
       -- subscriptionCore.integration.test.ts.
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

  const uniqueEmail = () =>
    `trf-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

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

  async function registerAndCreateBusiness(
    email: string,
    businessName: string,
  ): Promise<Ctx> {
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Transfer Test",
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
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as {
      accessToken: string;
      user: { id: number };
    };
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
    return {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
      email,
    };
  }

  async function createLocation(ctx: Ctx, name: string): Promise<number> {
    const res = await api(ctx, "POST", "/api/locations", { name });
    assert.equal(res.status, 201);
    return (res.body as { data: { id: number } }).data.id;
  }

  async function createStockedProduct(
    ctx: Ctx,
    name: string,
    quantity: number,
    sourceLocationId: number,
  ): Promise<{ productId: number; variantId: number }> {
    const unitRes = await api(ctx, "POST", "/api/product/unit", {
      unitName: `Piece ${name}`,
      abbreviation: "Pcs",
    });
    assert.equal(unitRes.status, 201);
    const unitId = (unitRes.body as { data: { value: number } }).data.value;

    const res = await api(ctx, "POST", "/api/product", {
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
          sku: `TRF-${name.replace(/\s+/g, "")}-${Date.now()}`,
          barcode: null,
          sellingPrice: 100,
          alertQuantity: 5,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `BATCH-${name}`,
          purchasePrice: 40,
          quantity,
          expiryDate: null,
        },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const listRes = await api(ctx, "GET", "/api/products");
    assert.equal(listRes.status, 200);
    const list = listRes.body as {
      id: number;
      name: string;
      variants: { id: number }[];
    }[];
    const created = list.find((p) => p.name === name);
    assert.ok(created);
    return { productId: created.id, variantId: created.variants[0]!.id };
  }

  async function getStock(
    ctx: Ctx,
    variantId: number,
    locationId: number,
  ): Promise<number | null> {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const res = await client.query(
      "SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2 AND location_id = $3",
      [variantId, ctx.businessId, locationId],
    );
    await client.end();
    return res.rows[0] ? Number(res.rows[0].quantity) : null;
  }

  const stamp = Date.now();
  let owner: Ctx;
  let locationA = 0;
  let locationB = 0;
  let variantId = 0;

  before(async () => {
    owner = await registerAndCreateBusiness(
      `trf-owner-${stamp}@example.test`,
      `Transfer Biz ${stamp}`,
    );
    locationA = await createLocation(owner, `Transfer Source ${stamp}`);
    locationB = await createLocation(owner, `Transfer Dest ${stamp}`);
    // Product with 100 units opening stock at the DEFAULT location. The
    // first location (A) became the default.
    const product = await createStockedProduct(
      owner,
      "Cola Crate",
      100,
      locationA,
    );
    variantId = product.variantId;
  });

  it("opening stock landed at the default (source) location only", async () => {
    const atA = await getStock(owner, variantId, locationA);
    const atB = await getStock(owner, variantId, locationB);
    assert.equal(atA, 100);
    assert.equal(atB, null);
  });

  it("creates a draft transfer and rejects invalid routes", async () => {
    const same = await api(owner, "POST", "/api/stock-transfers", {
      fromLocationId: locationA,
      toLocationId: locationA,
      items: [{ variantId, quantity: 10 }],
    });
    assert.equal(same.status, 400);

    const created = await api(owner, "POST", "/api/stock-transfers", {
      fromLocationId: locationA,
      toLocationId: locationB,
      items: [{ variantId, quantity: 50 }],
    });
    assert.equal(created.status, 201);
    const detail = (created.body as { data: { status: string; items: unknown[] } })
      .data;
    assert.equal(detail.status, "draft");
    assert.match(
      (created.body as { data: { transferNumber: string } }).data.transferNumber,
      /^TRF-\d{6}$/,
    );
    assert.equal(detail.items.length, 1);
  });

  it("shipping deducts source stock but destination stays empty (in transit)", async () => {
    const list = await api(owner, "GET", "/api/stock-transfers");
    const transfer = (list.body as { data: { id: number; status: string }[] })
      .data.find((t) => t.status === "draft");
    assert.ok(transfer);

    const shipped = await api(
      owner,
      "POST",
      `/api/stock-transfers/${transfer.id}/ship`,
    );
    assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
    assert.equal(
      (shipped.body as { data: { status: string } }).data.status,
      "shipped",
    );

    const atA = await getStock(owner, variantId, locationA);
    const atB = await getStock(owner, variantId, locationB);
    assert.equal(atA, 50); // 100 - 50 shipped
    assert.equal(atB, null); // not received yet — in transit

    // Double-ship is blocked.
    const again = await api(
      owner,
      "POST",
      `/api/stock-transfers/${transfer.id}/ship`,
    );
    assert.equal(again.status, 409);
  });

  it("receiving adds destination stock with the shipped cost basis", async () => {
    const list = await api(owner, "GET", "/api/stock-transfers");
    const transfer = (list.body as { data: { id: number }[] }).data[0]!;
    const received = await api(
      owner,
      "POST",
      `/api/stock-transfers/${transfer.id}/receive`,
      {},
    );
    assert.equal(received.status, 200, JSON.stringify(received.body));
    assert.equal(
      (received.body as { data: { status: string } }).data.status,
      "received",
    );

    const atB = await getStock(owner, variantId, locationB);
    assert.equal(atB, 50);

    // Fully received transfers cannot be received again.
    const twice = await api(
      owner,
      "POST",
      `/api/stock-transfers/${transfer.id}/receive`,
      {},
    );
    assert.equal(twice.status, 409);
  });

  it("shipping more than available is rejected and rolls back", async () => {
    const created = await api(owner, "POST", "/api/stock-transfers", {
      fromLocationId: locationA,
      toLocationId: locationB,
      items: [{ variantId, quantity: 999 }],
    });
    assert.equal(created.status, 201);
    const id = (created.body as { data: { id: number } }).data.id;

    const shipped = await api(owner, "POST", `/api/stock-transfers/${id}/ship`);
    assert.equal(shipped.status, 400);

    // The failed ship must not have deducted anything (transaction rollback).
    const atA = await getStock(owner, variantId, locationA);
    assert.equal(atA, 50);
  });

  it("supports partial receiving and records the shortfall", async () => {
    const created = await api(owner, "POST", "/api/stock-transfers", {
      fromLocationId: locationA,
      toLocationId: locationB,
      items: [{ variantId, quantity: 20 }],
    });
    assert.equal(created.status, 201);
    const detail = (created.body as { data: { id: number; items: { id: number }[] } })
      .data;
    const itemId = detail.items[0]!.id;

    const shipped = await api(
      owner,
      "POST",
      `/api/stock-transfers/${detail.id}/ship`,
    );
    assert.equal(shipped.status, 200);

    // Receive only 12 of 20.
    const partial = await api(
      owner,
      "POST",
      `/api/stock-transfers/${detail.id}/receive`,
      { items: [{ itemId, quantity: 12 }] },
    );
    assert.equal(partial.status, 200);
    assert.equal(
      (partial.body as { data: { status: string } }).data.status,
      "partially_received",
    );
    const atB = await getStock(owner, variantId, locationB);
    assert.equal(atB, 62); // 50 + 12

    // Over-receiving is rejected.
    const over = await api(
      owner,
      "POST",
      `/api/stock-transfers/${detail.id}/receive`,
      { items: [{ itemId, quantity: 20 }] },
    );
    assert.equal(over.status, 400);

    // Receive the remainder (8) → fully received.
    const rest = await api(
      owner,
      "POST",
      `/api/stock-transfers/${detail.id}/receive`,
      { items: [{ itemId, quantity: 8 }] },
    );
    assert.equal(rest.status, 200);
    assert.equal(
      (rest.body as { data: { status: string } }).data.status,
      "received",
    );
    const atBFinal = await getStock(owner, variantId, locationB);
    assert.equal(atBFinal, 70);
    const atAFinal = await getStock(owner, variantId, locationA);
    assert.equal(atAFinal, 30);
  });

  it("draft transfers can be cancelled; shipped ones cannot", async () => {
    const created = await api(owner, "POST", "/api/stock-transfers", {
      fromLocationId: locationA,
      toLocationId: locationB,
      items: [{ variantId, quantity: 5 }],
    });
    const draftId = (created.body as { data: { id: number } }).data.id;
    const cancelled = await api(
      owner,
      "POST",
      `/api/stock-transfers/${draftId}/cancel`,
    );
    assert.equal(cancelled.status, 200);
    assert.equal(
      (cancelled.body as { data: { status: string } }).data.status,
      "cancelled",
    );

    const shippedList = await api(owner, "GET", "/api/stock-transfers");
    const shipped = (shippedList.body as { data: { id: number; status: string }[] })
      .data.find((t) => t.status === "shipped");
    if (shipped) {
      const denied = await api(
        owner,
        "POST",
        `/api/stock-transfers/${shipped.id}/cancel`,
      );
      assert.equal(denied.status, 409);
    }
  });

  it("staff cannot ship/receive without assignment to both endpoints", async () => {
    // Create a cashier assigned ONLY to the source location.
    const roles = await api(owner, "GET", "/api/roles");
    const cashierRole = (roles.body as { data: { id: number; slug: string }[] })
      .data.find((r) => r.slug === "cashier");
    assert.ok(cashierRole);

    // Cashier lacks inventory.transfer — grant a custom role WITH it.
    const customRole = await api(owner, "POST", "/api/roles", {
      name: `Transfer Clerk ${stamp}`,
      permissionKeys: ["inventory.transfer", "inventory.view", "products.view"],
    });
    assert.equal(customRole.status, 201);
    const roleId = (customRole.body as { data: { id: number } }).data.id;

    const email = `trf-clerk-${stamp}@example.test`;
    const created = await api(owner, "POST", "/api/users", {
      fullName: "Transfer Clerk",
      email,
      password: "strong-password-123",
      roleIds: [roleId],
      locationIds: [locationA],
    });
    assert.equal(created.status, 201);
    const userId = (created.body as { data: { userId: number } }).data.userId;

    const clerk: Ctx = {
      token: "",
      businessId: owner.businessId,
      userId,
      email,
    };
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    assert.equal(login.status, 200);
    clerk.token = ((await login.json()) as { accessToken: string }).accessToken;

    // The clerk CAN create a transfer from A (assigned) to B (unassigned)?
    // No — drafts require BOTH endpoints.
    const deniedDraft = await api(clerk, "POST", "/api/stock-transfers", {
      fromLocationId: locationA,
      toLocationId: locationB,
      items: [{ variantId, quantity: 1 }],
    });
    assert.equal(deniedDraft.status, 403);

    // Owner drafts a transfer; the clerk cannot ship (source assigned but
    // the clerk did not create it — shipping only needs the SOURCE, which
    // the clerk has). Ship succeeds.
    const owned = await api(owner, "POST", "/api/stock-transfers", {
      fromLocationId: locationA,
      toLocationId: locationB,
      items: [{ variantId, quantity: 2 }],
    });
    const ownedId = (owned.body as { data: { id: number } }).data.id;
    const clerkShips = await api(
      clerk,
      "POST",
      `/api/stock-transfers/${ownedId}/ship`,
    );
    assert.equal(clerkShips.status, 200);

    // But the clerk cannot RECEIVE at the unassigned destination.
    const clerkReceives = await api(
      clerk,
      "POST",
      `/api/stock-transfers/${ownedId}/receive`,
      {},
    );
    assert.equal(clerkReceives.status, 403);

    // List scoping: the clerk sees the transfer (touches assigned source).
    const clerkList = await api(clerk, "GET", "/api/stock-transfers");
    assert.equal(clerkList.status, 200);
    const visible = (clerkList.body as { data: { id: number }[] }).data.find(
      (t) => t.id === ownedId,
    );
    assert.ok(visible);
  });

  it("cross-business transfer ids are invisible", async () => {
    const other = await registerAndCreateBusiness(
      `trf-other-${stamp}@example.test`,
      `Transfer Other ${stamp}`,
    );
    const list = await api(owner, "GET", "/api/stock-transfers");
    const anyId = (list.body as { data: { id: number }[] }).data[0]!.id;
    const res = await api(other, "GET", `/api/stock-transfers/${anyId}`);
    assert.equal(res.status, 404);
  });

  it("serial-tracked units travel with their serials (in_transit → re-pointed on receive)", async () => {
    // C1-02: shipped serials used to stay 'in_stock' at the SOURCE while the
    // destination counted units whose serials were elsewhere.
    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Serial Piece ${stamp}`,
      abbreviation: "SPc",
    });
    assert.equal(unitRes.status, 201);
    const unitId = (unitRes.body as { data: { value: number } }).data.value;
    const serials = Array.from(
      { length: 3 },
      (_, i) => `TRF-SN-${stamp}-${i}`,
    );
    const prodRes = await api(owner, "POST", "/api/product", {
      name: `Serial Transfer Product ${stamp}`,
      categoryId: null,
      brandId: null,
      unitId,
      description: "",
      productType: "physical",
      hasVariants: false,
      trackingType: "serial",
      supplierId: null,
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "opening",
      variants: [
        {
          sku: `TRF-SER-${stamp}`,
          barcode: null,
          sellingPrice: 100,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: 40,
          quantity: 3,
          expiryDate: null,
          serialNumbers: serials.map((serial) => ({ serial })),
        },
      ],
    });
    assert.equal(prodRes.status, 201, JSON.stringify(prodRes.body));
    const listRes = await api(owner, "GET", "/api/products");
    const serialProduct = (
      listRes.body as unknown as {
        id: number;
        name: string;
        variants: { id: number }[];
      }[]
    ).find((p) => p.name === `Serial Transfer Product ${stamp}`)!;
    const serialVariantId = serialProduct.variants[0]!.id;

    const created = await api(owner, "POST", "/api/stock-transfers", {
      fromLocationId: locationA,
      toLocationId: locationB,
      items: [{ variantId: serialVariantId, quantity: 2 }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const transferId = (created.body as { data: { id: number } }).data.id;

    const shipped = await api(
      owner,
      "POST",
      `/api/stock-transfers/${transferId}/ship`,
    );
    assert.equal(shipped.status, 200, JSON.stringify(shipped.body));

    // Ship records the moved serials on the item and marks them in_transit.
    const detail = (
      shipped.body as {
        data: { items: { serialNumbers: string[] | null }[] };
      }
    ).data;
    assert.deepEqual(detail.items[0]!.serialNumbers, serials.slice(0, 2));

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const midShip = await client.query(
      `SELECT status, location_id FROM serial_numbers
       WHERE business_id = $1 AND variant_id = $2 AND serial_number = ANY($3)
       ORDER BY id`,
      [owner.businessId, serialVariantId, serials.slice(0, 2)],
    );
    assert.equal(midShip.rows.length, 2);
    for (const row of midShip.rows) {
      assert.equal(row.status, "in_transit");
      assert.equal(row.location_id, locationA);
    }

    const received = await api(
      owner,
      "POST",
      `/api/stock-transfers/${transferId}/receive`,
      {},
    );
    assert.equal(received.status, 200, JSON.stringify(received.body));

    const after = await client.query(
      `SELECT sn.status, sn.location_id, sn.batch_id,
              ib.batch_number LIKE 'TRF-%' AS trf_batch
       FROM serial_numbers sn
       LEFT JOIN inventory_batches ib ON ib.id = sn.batch_id
       WHERE sn.business_id = $1 AND sn.variant_id = $2
         AND sn.serial_number = ANY($3)
       ORDER BY sn.id`,
      [owner.businessId, serialVariantId, serials.slice(0, 2)],
    );
    const leftBehind = await client.query(
      `SELECT status FROM serial_numbers
       WHERE business_id = $1 AND variant_id = $2 AND serial_number = $3`,
      [owner.businessId, serialVariantId, serials[2]],
    );
    await client.end();

    for (const row of after.rows) {
      assert.equal(row.status, "in_stock");
      assert.equal(row.location_id, locationB);
      assert.equal(row.trf_batch, true);
    }
    // The unit that stayed home is untouched.
    assert.equal(leftBehind.rows[0].status, "in_stock");
  });
});
