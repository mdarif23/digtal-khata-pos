/**
 * Purchase receive integration tests (audit gap: receiving was never
 * exercised end-to-end): PO creation, partial/full receiving, stock + batch
 * + movement side effects, payment caps, location locking — against a REAL
 * PostgreSQL database. Double-guarded like the other suites.
 *
 * Plain `npm test` NEVER runs this file.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ensureRbacSeed } from "../rbac/seed.js";
import { connectTestDb } from "./helpers/db.js";
import {
  createOwnerCtx,
  postJson,
  type OwnerCtx,
} from "./helpers/fixtures.js";
import { startTestServer } from "./helpers/server.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("purchase receive integration", { skip: !runIntegration }, () => {
  let closeServer: (() => Promise<void>) | null = null;
  let baseUrl = "";
  let pg: import("pg").Client | null = null;

  before(async () => {
    pg = await connectTestDb();
    await ensureRbacSeed();
    const server = startTestServer();
    baseUrl = server.baseUrl;
    closeServer = server.close;
  });

  after(async () => {
    await closeServer?.();
    await pg?.end();
    pg = null;
  });

  let counter = 0;

  async function seedVariant(
    businessId: number,
    qty = 0,
    trackingType = "none",
  ): Promise<number> {
    const location = (await pg!.query(
      "SELECT id FROM locations WHERE business_id = $1 AND is_default = true",
      [businessId],
    )).rows[0] as { id: number } | undefined;
    assert.ok(location, "default location missing");
    const product = await pg!.query(
      `INSERT INTO products (business_id, name, product_type, tracking_type, status)
       VALUES ($1, $2, 'physical', $3, 'active') RETURNING id`,
      [businessId, `Product ${Date.now()}-${(counter += 1)}`, trackingType],
    );
    const variant = await pg!.query(
      `INSERT INTO product_variants (business_id, product_id, sku, selling_price, is_default, status)
       VALUES ($1, $2, $3, 100, true, 'active') RETURNING id`,
      [businessId, product.rows[0]!.id, `SKU-${Date.now()}-${(counter += 1)}`],
    );
    await pg!.query(
      `INSERT INTO inventory_stock (business_id, variant_id, location_id, quantity, reserved_quantity)
       VALUES ($1, $2, $3, $4, 0)`,
      [businessId, variant.rows[0]!.id, location.id, qty],
    );
    return variant.rows[0]!.id as number;
  }

  async function stockRow(businessId: number, variantId: number) {
    const { rows } = await pg!.query(
      "SELECT quantity FROM inventory_stock WHERE business_id = $1 AND variant_id = $2",
      [businessId, variantId],
    );
    return rows[0] as { quantity: number } | undefined;
  }

  async function createSupplier(ctx: OwnerCtx): Promise<number> {
    const { status, body } = await postJson(
      baseUrl,
      ctx,
      "/api/contacts/supplier",
      {
        supplierName: `Supplier ${Date.now()}-${(counter += 1)}`,
        phone: "+8801711000000",
        email: `supplier-${Date.now()}-${(counter += 1)}@example.test`,
        address: "Test address",
      },
    );
    assert.equal(status, 201, `supplier create failed: ${JSON.stringify(body)}`);
    const id = body?.data?.supplierId;
    assert.ok(id, "supplierId missing from response");
    return Number(id);
  }

  async function createPurchase(
    ctx: OwnerCtx,
    supplierId: number | null,
    variantId: number,
    qty: number,
    price: number,
  ): Promise<{ id: number; poNumber: string }> {
    const { status, body } = await postJson(baseUrl, ctx, "/api/purchases", {
      items: [{ variantId, quantity: qty, purchasePrice: price }],
      supplierId,
      purchaseDate: new Date().toISOString(),
    });
    assert.equal(status, 201, `purchase create failed: ${JSON.stringify(body)}`);
    assert.ok(body?.data?.id, "purchase id missing");
    return {
      id: Number(body.data.id),
      poNumber: body.data.purchaseOrderNumber,
    };
  }

  async function purchaseItemRows(purchaseId: number) {
    const { rows } = await pg!.query(
      `SELECT id, variant_id, quantity, received_quantity
       FROM purchase_items WHERE purchase_id = $1 ORDER BY id`,
      [purchaseId],
    );
    return rows as {
      id: number;
      variant_id: number;
      quantity: string;
      received_quantity: string;
    }[];
  }

  function receivePlan(
    rows: { id: number }[],
    plan: { receiveNow: number; unitCost: number; sellingPrice: number }[],
    trackingType = "none",
    batchesByItem: Record<
      number,
      { batchNumber: string; quantity: number }[]
    > = {},
  ) {
    return rows.map((row, i) => ({
      itemId: row.id,
      trackingType,
      receiveNow: plan[i]?.receiveNow ?? 0,
      unitCost: plan[i]?.unitCost ?? 0,
      sellingPrice: plan[i]?.sellingPrice ?? 0,
      batches: (batchesByItem[row.id] ?? []).map((b) => ({
        ...b,
        manufacturedDate: "2026-01-01",
        expiryDate: "2027-01-01",
      })),
      serialNumbers: [],
    }));
  }

  it("creates a purchase order with a per-business PO number", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive PO Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchase = await createPurchase(owner, supplierId, variantId, 5, 60);

    assert.match(purchase.poNumber, /^PO-\d{4}-\d{6}$/);

    const header = (await pg!.query(
      `SELECT total_amount, due_amount, paid_amount, status
       FROM purchases WHERE id = $1`,
      [purchase.id],
    )).rows[0] as {
      total_amount: string;
      due_amount: string;
      paid_amount: string;
      status: string;
    };
    assert.equal(Number(header.total_amount), 300);
    assert.equal(Number(header.due_amount), 300);
    assert.equal(Number(header.paid_amount), 0);
    assert.equal(header.status, "ordered");
  });

  it("receives in full: stock up, movement, AUTO batch, price overwrite, payment", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive Full Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchase = await createPurchase(owner, supplierId, variantId, 5, 60);
    const rows = await purchaseItemRows(purchase.id);

    const { status, body } = await postJson(
      baseUrl,
      owner,
      "/api/purchases/receive",
      {
        purchaseId: purchase.id,
        items: receivePlan(rows, [
          { receiveNow: 5, unitCost: 60, sellingPrice: 150 },
        ]),
        paymentAmount: 300,
        paymentMethod: "cash",
      },
    );
    assert.equal(status, 201, `receive failed: ${JSON.stringify(body)}`);
    assert.equal(body?.data?.status, "received");
    assert.equal(Number(body?.data?.paidAmount), 300);
    assert.equal(Number(body?.data?.dueAmount), 0);

    const stock = await stockRow(owner.businessId, variantId);
    assert.equal(stock?.quantity, 5);

    const movement = (await pg!.query(
      `SELECT quantity FROM inventory_movements
       WHERE movement_type = 'purchase' AND reference_type = 'purchase'
         AND reference_id = $1`,
      [purchase.id],
    )).rows[0] as { quantity: number } | undefined;
    assert.ok(movement, "purchase movement row missing");
    assert.equal(Number(movement.quantity), 5);

    const batch = (await pg!.query(
      `SELECT batch_number, quantity_received, quantity_remaining
       FROM inventory_batches WHERE variant_id = $1 AND business_id = $2`,
      [variantId, owner.businessId],
    )).rows[0] as {
      batch_number: string;
      quantity_received: string;
      quantity_remaining: string;
    } | undefined;
    assert.ok(batch, "inventory batch missing after receive");
    assert.match(batch.batch_number, /^AUTO-/);
    assert.equal(Number(batch.quantity_received), 5);

    const price = (await pg!.query(
      "SELECT selling_price FROM product_variants WHERE id = $1",
      [variantId],
    )).rows[0] as { selling_price: string };
    assert.equal(Number(price.selling_price), 150);
  });

  it("supports partial receiving", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive Partial Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchase = await createPurchase(owner, supplierId, variantId, 4, 50);
    const rows = await purchaseItemRows(purchase.id);

    const { status, body } = await postJson(
      baseUrl,
      owner,
      "/api/purchases/receive",
      {
        purchaseId: purchase.id,
        items: receivePlan(rows, [
          { receiveNow: 2, unitCost: 50, sellingPrice: 100 },
        ]),
        paymentAmount: 0,
        paymentMethod: "cash",
      },
    );
    assert.equal(status, 201, `receive failed: ${JSON.stringify(body)}`);
    assert.equal(body?.data?.status, "partially_received");
    assert.ok(Number(body?.data?.dueAmount) > 0, "due amount should remain");

    const stock = await stockRow(owner.businessId, variantId);
    assert.equal(stock?.quantity, 2);

    const [item] = rows;
    const refreshed = (await pg!.query(
      "SELECT received_quantity FROM purchase_items WHERE id = $1",
      [item!.id],
    )).rows[0] as { received_quantity: string };
    assert.equal(Number(refreshed.received_quantity), 2);
  });

  it("pins current behavior: an empty receive payload is a no-op", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive Empty Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchase = await createPurchase(owner, supplierId, variantId, 2, 50);
    const rows = await purchaseItemRows(purchase.id);

    // A receive with no item rows succeeds and touches nothing. The 404
    // "Missing receiving information" guard only fires when SOME items are
    // provided but a purchase item is left out of a non-empty payload.
    const { status } = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: purchase.id,
      items: receivePlan(rows, []),
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(status, 201);

    const stock = await stockRow(owner.businessId, variantId);
    assert.equal(stock?.quantity ?? 0, 0);
  });

  it("rejects payments above the received value (no silent cap)", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive Cap Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchase = await createPurchase(owner, supplierId, variantId, 2, 50);
    const rows = await purchaseItemRows(purchase.id);

    const { status, body } = await postJson(
      baseUrl,
      owner,
      "/api/purchases/receive",
      {
        purchaseId: purchase.id,
        items: receivePlan(rows, [
          { receiveNow: 2, unitCost: 50, sellingPrice: 100 },
        ]),
        paymentAmount: 500, // way above the 100 received value
        paymentMethod: "cash",
      },
    );
    assert.equal(status, 404);
    assert.match(String(body?.message), /Payment cannot be greater/);

    // The exact received value is accepted.
    const ok = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: purchase.id,
      items: receivePlan(rows, [
        { receiveNow: 2, unitCost: 50, sellingPrice: 100 },
      ]),
      paymentAmount: 100,
      paymentMethod: "cash",
    });
    assert.equal(ok.status, 201, `receive failed: ${JSON.stringify(ok.body)}`);
    assert.equal(Number(ok.body?.data?.paidAmount), 100);
    assert.equal(Number(ok.body?.data?.dueAmount), 0);
  });

  it("locks the purchase to the first receiving location", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive Lock Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchase = await createPurchase(owner, supplierId, variantId, 2, 50);
    const rows = await purchaseItemRows(purchase.id);

    const branch = await postJson(baseUrl, owner, "/api/locations", {
      name: "Branch",
    });
    assert.equal(branch.status, 201);
    const branchId =
      branch.body?.data?.id ?? branch.body?.data?.location?.id;
    assert.ok(branchId, "branch location id missing");

    const first = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: purchase.id,
      items: receivePlan(rows, [
        { receiveNow: 1, unitCost: 50, sellingPrice: 100 },
      ]),
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(first.status, 201);

    const second = await postJson(
      baseUrl,
      owner,
      "/api/purchases/receive",
      {
        purchaseId: purchase.id,
        items: receivePlan(rows, [
          { receiveNow: 1, unitCost: 50, sellingPrice: 100 },
        ]),
        paymentAmount: 0,
        paymentMethod: "cash",
      },
      { "X-Location-Id": String(branchId) },
    );
    assert.equal(second.status, 409);
    assert.match(String(second.body?.message), /another location/);
  });

  it("requires batch quantities to sum to receiveNow", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive Batch Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId, 0, "batch");
    const purchase = await createPurchase(owner, supplierId, variantId, 3, 50);
    const rows = await purchaseItemRows(purchase.id);

    const { status, body } = await postJson(
      baseUrl,
      owner,
      "/api/purchases/receive",
      {
        purchaseId: purchase.id,
        items: receivePlan(
          rows,
          [{ receiveNow: 3, unitCost: 50, sellingPrice: 100 }],
          "batch",
          {
            [rows[0]!.id]: [{ batchNumber: "BATCH-A", quantity: 2 }],
          },
        ),
        paymentAmount: 0,
        paymentMethod: "cash",
      },
    );
    assert.equal(status, 400);
    assert.equal(body?.message, "Invalid Purchase Data");
  });

  it("receives batch-tracked items into named batches", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive Batches Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId, 0, "batch");
    const purchase = await createPurchase(owner, supplierId, variantId, 3, 50);
    const rows = await purchaseItemRows(purchase.id);

    const { status, body } = await postJson(
      baseUrl,
      owner,
      "/api/purchases/receive",
      {
        purchaseId: purchase.id,
        items: receivePlan(
          rows,
          [{ receiveNow: 3, unitCost: 50, sellingPrice: 100 }],
          "batch",
          {
            [rows[0]!.id]: [
              { batchNumber: "BATCH-A", quantity: 2 },
              { batchNumber: "BATCH-B", quantity: 1 },
            ],
          },
        ),
        paymentAmount: 0,
        paymentMethod: "cash",
      },
    );
    assert.equal(status, 201, `receive failed: ${JSON.stringify(body)}`);

    const batches = (await pg!.query(
      `SELECT batch_number, quantity_remaining FROM inventory_batches
       WHERE variant_id = $1 AND business_id = $2 ORDER BY batch_number`,
      [variantId, owner.businessId],
    )).rows as { batch_number: string; quantity_remaining: string }[];
    assert.deepEqual(
      batches.map((b) => b.batch_number),
      ["BATCH-A", "BATCH-B"],
    );
    assert.deepEqual(
      batches.map((b) => Number(b.quantity_remaining)),
      [2, 1],
    );
  });
});
