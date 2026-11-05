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
  getJson,
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
    assert.equal(status, 400);
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

  it("keeps the line cost at the PO cost across sessions with different receive costs (D1)", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive D1 Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    // 10 ordered @ 100 → total 1000
    const purchase = await createPurchase(owner, supplierId, variantId, 10, 100);
    const rows = await purchaseItemRows(purchase.id);

    // Session 1: 4 units @ 100, pay 400.
    const first = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: purchase.id,
      items: receivePlan(rows, [
        { receiveNow: 4, unitCost: 100, sellingPrice: 150 },
      ]),
      paymentAmount: 400,
      paymentMethod: "cash",
    });
    assert.equal(first.status, 201, `receive 1 failed: ${JSON.stringify(first.body)}`);
    assert.equal(Number(first.body?.data?.paidAmount), 400);
    assert.equal(Number(first.body?.data?.receivedAmount), 400);

    // Session 2, first attempt: paying 700 in-session must be rejected —
    // the limit is min(true received value 1600, invoice total 1000) − 400.
    const capped = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: purchase.id,
      items: receivePlan(rows, [
        { receiveNow: 6, unitCost: 200, sellingPrice: 150 },
      ]),
      paymentAmount: 700,
      paymentMethod: "cash",
    });
    assert.equal(capped.status, 400);
    assert.match(String(capped.body?.message), /Payment cannot be greater/);

    // Session 2, actual: 6 units @ 200, no payment.
    const second = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: purchase.id,
      items: receivePlan(rows, [
        { receiveNow: 6, unitCost: 200, sellingPrice: 150 },
      ]),
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(second.status, 201, `receive 2 failed: ${JSON.stringify(second.body)}`);
    // Batch-authoritative received value: 4×100 + 6×200 = 1600.
    assert.equal(Number(second.body?.data?.receivedAmount), 1600);
    assert.equal(second.body?.data?.status, "received");
    // Landed-cost feedback is always present (no document → not adjusted).
    assert.deepEqual(second.body?.data?.landedCost, {
      adjusted: false,
      amount: 0,
      documentId: null,
    });

    // The LINE cost stays the PO cost (100) — never overwritten.
    const line = (await pg!.query(
      "SELECT unit_cost, received_quantity FROM purchase_items WHERE id = $1",
      [rows[0]!.id],
    )).rows[0] as { unit_cost: string; received_quantity: string };
    assert.equal(Number(line.unit_cost), 100);
    assert.equal(Number(line.received_quantity), 10);

    // Per-session costs live on the batches: 4 @ 100 and 6 @ 200.
    const batches = (await pg!.query(
      `SELECT purchase_price, quantity_received FROM inventory_batches
       WHERE purchase_item_id = $1 AND business_id = $2 ORDER BY id`,
      [rows[0]!.id, owner.businessId],
    )).rows as { purchase_price: string; quantity_received: string }[];
    assert.deepEqual(
      batches.map((b) => Number(b.purchase_price)),
      [100, 200],
    );
    assert.deepEqual(
      batches.map((b) => Number(b.quantity_received)),
      [4, 6],
    );

    // A fully received purchase no longer accepts receives (payments for it
    // go through due-management, which shares the same limit math).
    const paymentOnly = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: purchase.id,
      items: receivePlan(rows, [
        { receiveNow: 0, unitCost: 0, sellingPrice: 0 },
      ]),
      paymentAmount: 600,
      paymentMethod: "cash",
    });
    assert.equal(paymentOnly.status, 409);

    // Same limit on the due-management supplier-payment path (shared
    // calculatePayments): 700 over the 600 limit → 400; 600 settles it.
    const over = await postJson(
      baseUrl,
      owner,
      "/api/due-management/supplier-payment",
      { purchaseId: purchase.id, amount: 700, method: "cash" },
    );
    assert.equal(over.status, 400);
    assert.match(String(over.body?.message), /Payment cannot be greater/);

    const settle = await postJson(
      baseUrl,
      owner,
      "/api/due-management/supplier-payment",
      { purchaseId: purchase.id, amount: 600, method: "cash" },
    );
    assert.equal(settle.status, 201, `settle failed: ${JSON.stringify(settle.body)}`);
    assert.equal(Number(settle.body?.data?.outstandingAfter), 0);
  });

  it("rejects a receive-time cost override above the invoice total cap (D1 sanity)", async () => {
    // Order 2 @ 50 (total 100) but receive at 80: the batch value is 160,
    // the invoice total still caps what can be paid.
    const owner = await createOwnerCtx(baseUrl, "Receive Override Co");
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
          { receiveNow: 2, unitCost: 80, sellingPrice: 100 },
        ]),
        paymentAmount: 160,
        paymentMethod: "cash",
      },
    );
    assert.equal(status, 400);
    assert.match(String(body?.message), /Payment cannot be greater/);
  });

  it("rejects serial numbers that already exist in the business", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive SerialDup Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId, 0, "serial");

    const serialItem = (row: { id: number }, serials: string[]) => ({
      itemId: row.id,
      trackingType: "serial",
      receiveNow: serials.length,
      unitCost: 50,
      sellingPrice: 100,
      batches: [],
      serialNumbers: serials,
    });

    const first = await createPurchase(owner, supplierId, variantId, 1, 50);
    const firstRows = await purchaseItemRows(first.id);
    const ok = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: first.id,
      items: [serialItem(firstRows[0]!, ["SN-DUP-1"])],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(ok.status, 201, `first serial receive failed: ${JSON.stringify(ok.body)}`);

    const second = await createPurchase(owner, supplierId, variantId, 2, 50);
    const secondRows = await purchaseItemRows(second.id);
    const dup = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: second.id,
      items: [serialItem(secondRows[0]!, ["SN-NEW-2", "SN-DUP-1"])],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(dup.status, 400);
    assert.match(String(dup.body?.message), /already exist/);
  });

  it("rejects the same serial listed for two lines sharing one variant", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive SerialX Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId, 0, "serial");

    // Two purchase lines sharing the same variant on one PO.
    const { status: poStatus, body: poBody } = await postJson(
      baseUrl,
      owner,
      "/api/purchases",
      {
        items: [
          { variantId, quantity: 1, purchasePrice: 50 },
          { variantId, quantity: 1, purchasePrice: 50 },
        ],
        supplierId,
        purchaseDate: new Date().toISOString(),
      },
    );
    assert.equal(poStatus, 201, `purchase create failed: ${JSON.stringify(poBody)}`);
    const purchaseId = Number(poBody.data.id);
    const rows = await purchaseItemRows(purchaseId);
    assert.equal(rows.length, 2);

    const { status, body } = await postJson(
      baseUrl,
      owner,
      "/api/purchases/receive",
      {
        purchaseId,
        items: rows.map((row) => ({
          itemId: row.id,
          trackingType: "serial",
          receiveNow: 1,
          unitCost: 50,
          sellingPrice: 100,
          batches: [],
          serialNumbers: ["SN-SHARED"],
        })),
        paymentAmount: 0,
        paymentMethod: "cash",
      },
    );
    assert.equal(status, 400);
    assert.match(String(body?.message), /more than one item/);
  });

  it("rejects duplicate batch numbers within a single receive", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive BatchDup Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId, 0, "batch");
    const purchase = await createPurchase(owner, supplierId, variantId, 4, 50);
    const rows = await purchaseItemRows(purchase.id);

    const { status, body } = await postJson(
      baseUrl,
      owner,
      "/api/purchases/receive",
      {
        purchaseId: purchase.id,
        items: receivePlan(
          rows,
          [{ receiveNow: 4, unitCost: 50, sellingPrice: 100 }],
          "batch",
          {
            [rows[0]!.id]: [
              { batchNumber: "BATCH-DUP", quantity: 2 },
              { batchNumber: "BATCH-DUP", quantity: 2 },
            ],
          },
        ),
        paymentAmount: 0,
        paymentMethod: "cash",
      },
    );
    assert.equal(status, 400);
    assert.match(String(body?.message), /Duplicate batch numbers/);
  });

  it("rejects an expiry date before the manufacturing date", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive Expiry Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId, 0, "batch");
    const purchase = await createPurchase(owner, supplierId, variantId, 2, 50);
    const rows = await purchaseItemRows(purchase.id);

    const { status } = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: purchase.id,
      items: [
        {
          itemId: rows[0]!.id,
          trackingType: "batch",
          receiveNow: 2,
          unitCost: 50,
          sellingPrice: 100,
          batches: [
            {
              batchNumber: "BATCH-EXP",
              quantity: 2,
              manufacturedDate: "2026-06-01",
              expiryDate: "2025-06-01",
            },
          ],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(status, 400);
  });

  it("answers 409 when receiving an already fully received purchase", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive Again Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchase = await createPurchase(owner, supplierId, variantId, 2, 50);
    const rows = await purchaseItemRows(purchase.id);

    const full = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: purchase.id,
      items: receivePlan(rows, [
        { receiveNow: 2, unitCost: 50, sellingPrice: 100 },
      ]),
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(full.status, 201);

    const again = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: purchase.id,
      items: receivePlan(rows, [
        { receiveNow: 1, unitCost: 50, sellingPrice: 100 },
      ]),
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(again.status, 409);
    assert.match(String(again.body?.message), /already been completely received/);
  });

  it("rejects over-receiving and rolls the transaction back completely", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive Over Co");
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
          { receiveNow: 3, unitCost: 50, sellingPrice: 100 },
        ]),
        paymentAmount: 0,
        paymentMethod: "cash",
      },
    );
    assert.equal(status, 400);
    assert.match(String(body?.message), /Cannot receive 3 .* Only 2 remaining/);

    // Rollback proof: nothing was written.
    const stock = await stockRow(owner.businessId, variantId);
    assert.equal(Number(stock?.quantity ?? 0), 0);
    const line = (await pg!.query(
      "SELECT received_quantity FROM purchase_items WHERE id = $1",
      [rows[0]!.id],
    )).rows[0] as { received_quantity: string };
    assert.equal(Number(line.received_quantity), 0);
    const batches = await pg!.query(
      "SELECT id FROM inventory_batches WHERE purchase_item_id = $1",
      [rows[0]!.id],
    );
    assert.equal(batches.rows.length, 0);
  });

  it("rolls back the whole receive when one item of several is invalid", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive MultiRoll Co");
    const supplierId = await createSupplier(owner);
    // Two lines sharing one variant.
    const variantId = await seedVariant(owner.businessId);
    const { status: poStatus, body: poBody } = await postJson(
      baseUrl,
      owner,
      "/api/purchases",
      {
        items: [
          { variantId, quantity: 10, purchasePrice: 50 },
          { variantId, quantity: 10, purchasePrice: 50 },
        ],
        supplierId,
        purchaseDate: new Date().toISOString(),
      },
    );
    assert.equal(poStatus, 201);
    const purchaseId = Number(poBody.data.id);
    const rows = await purchaseItemRows(purchaseId);
    assert.equal(rows.length, 2);

    const { status, body } = await postJson(
      baseUrl,
      owner,
      "/api/purchases/receive",
      {
        purchaseId,
        items: receivePlan(rows, [
          { receiveNow: 5, unitCost: 50, sellingPrice: 100 },
          { receiveNow: 11, unitCost: 50, sellingPrice: 100 },
        ]),
        paymentAmount: 0,
        paymentMethod: "cash",
      },
    );
    assert.equal(status, 400);
    assert.match(String(body?.message), /Only 10 remaining/);

    // The VALID first item must not have been written either — one tx.
    const stock = await stockRow(owner.businessId, variantId);
    assert.equal(Number(stock?.quantity ?? 0), 0);
    for (const row of rows) {
      const line = (await pg!.query(
        "SELECT received_quantity FROM purchase_items WHERE id = $1",
        [row.id],
      )).rows[0] as { received_quantity: string };
      assert.equal(Number(line.received_quantity), 0);
      const batches = await pg!.query(
        "SELECT id FROM inventory_batches WHERE purchase_item_id = $1",
        [row.id],
      );
      assert.equal(batches.rows.length, 0);
    }
  });

  it("rejects a serial-tracked receive whose serial count mismatches", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive SerialCount Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId, 0, "serial");
    const purchase = await createPurchase(owner, supplierId, variantId, 2, 50);
    const rows = await purchaseItemRows(purchase.id);

    const { status, body } = await postJson(
      baseUrl,
      owner,
      "/api/purchases/receive",
      {
        purchaseId: purchase.id,
        items: [
          {
            itemId: rows[0]!.id,
            trackingType: "serial",
            receiveNow: 2,
            unitCost: 50,
            sellingPrice: 100,
            batches: [],
            serialNumbers: ["SN-ONLY-ONE"],
          },
        ],
        paymentAmount: 0,
        paymentMethod: "cash",
      },
    );
    assert.equal(status, 400);
    assert.equal(body?.message, "Invalid Purchase Data");
    const errors = (body?.errors as { fieldErrors?: Record<string, string[]> })
      ?.fieldErrors;
    assert.match(
      JSON.stringify(errors?.items ?? ""),
      /you provided 1 serial numbers/,
    );
  });

  it("serves the purchase detail endpoint (header + items + landed-cost status)", async () => {
    const owner = await createOwnerCtx(baseUrl, "Receive Detail Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchase = await createPurchase(owner, supplierId, variantId, 3, 50);
    const rows = await purchaseItemRows(purchase.id);

    const detail = await getJson(baseUrl, owner, `/api/purchases/${purchase.id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const body = detail.body as {
      purchase: {
        id: number;
        purchaseOrderNumber: string;
        supplierName: string | null;
        landedCostStatus: string | null;
      };
      items: {
        id: number;
        variantId: number;
        unitCost: string;
        trackingType: string;
        variantName?: string;
      }[];
    };
    assert.equal(body.purchase.id, purchase.id);
    assert.equal(body.purchase.purchaseOrderNumber, purchase.poNumber);
    // No landed-cost document → no indicator (only applicable states show).
    assert.equal(body.purchase.landedCostStatus, null);
    assert.equal(body.items.length, 1);
    assert.equal(Number(body.items[0]!.unitCost), 50);
    assert.equal(body.items[0]!.trackingType, "none");

    const missing = await getJson(baseUrl, owner, "/api/purchases/999999");
    assert.equal(missing.status, 404);
  });
});
