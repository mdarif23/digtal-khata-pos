/**
 * Purchase return integration tests — the audit's P0 gap module (the entire
 * /api/purchase-return surface had ZERO coverage): stock decrement, supplier
 * ledger credit, purchase due reduction, eligibility and on-hand guards —
 * against a REAL PostgreSQL database. Double-guarded like the other suites.
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

describe("purchase return integration", { skip: !runIntegration }, () => {
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

  async function seedVariant(businessId: number, qty = 0): Promise<number> {
    const location = (await pg!.query(
      "SELECT id FROM locations WHERE business_id = $1 AND is_default = true",
      [businessId],
    )).rows[0] as { id: number } | undefined;
    assert.ok(location, "default location missing");
    const product = await pg!.query(
      `INSERT INTO products (business_id, name, product_type, tracking_type, status)
       VALUES ($1, $2, 'physical', 'none', 'active') RETURNING id`,
      [businessId, `Product ${Date.now()}-${(counter += 1)}`],
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

  async function seedSerialVariant(businessId: number): Promise<number> {
    const location = (await pg!.query(
      "SELECT id FROM locations WHERE business_id = $1 AND is_default = true",
      [businessId],
    )).rows[0] as { id: number } | undefined;
    assert.ok(location, "default location missing");
    const product = await pg!.query(
      `INSERT INTO products (business_id, name, product_type, tracking_type, status)
       VALUES ($1, $2, 'physical', 'serial', 'active') RETURNING id`,
      [businessId, `Serial Product ${Date.now()}-${(counter += 1)}`],
    );
    const variant = await pg!.query(
      `INSERT INTO product_variants (business_id, product_id, sku, selling_price, is_default, status)
       VALUES ($1, $2, $3, 100, true, 'active') RETURNING id`,
      [businessId, product.rows[0]!.id, `SSKU-${Date.now()}-${(counter += 1)}`],
    );
    await pg!.query(
      `INSERT INTO inventory_stock (business_id, variant_id, location_id, quantity, reserved_quantity)
       VALUES ($1, $2, $3, 0, 0)`,
      [businessId, variant.rows[0]!.id, location.id],
    );
    return variant.rows[0]!.id as number;
  }

  /** Receives a serial-tracked line: serialNumbers define the quantity. */
  async function createReceivedSerialPurchase(
    ctx: OwnerCtx,
    variantId: number,
    serialNumbersIn: string[],
    opts: { supplierId: number },
  ) {
    const purchase = await postJson(baseUrl, ctx, "/api/purchases", {
      items: [
        { variantId, quantity: serialNumbersIn.length, purchasePrice: 100 },
      ],
      supplierId: opts.supplierId,
      purchaseDate: new Date().toISOString(),
    });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.body));
    const purchaseId = Number(purchase.body.data.id);
    const { rows } = await pg!.query(
      "SELECT id FROM purchase_items WHERE purchase_id = $1",
      [purchaseId],
    );
    const itemId = Number(rows[0]!.id);
    const received = await postJson(baseUrl, ctx, "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "serial",
          receiveNow: serialNumbersIn.length,
          unitCost: 100,
          sellingPrice: 100,
          batches: [],
          serialNumbers: serialNumbersIn,
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(received.status, 201, JSON.stringify(received.body));
    return { purchaseId, itemId };
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

  /** Purchase + full receive; returns the purchase item rows. */
  async function createReceivedPurchase(
    ctx: OwnerCtx,
    variantId: number,
    qty: number,
    unitCost: number,
    opts: { supplierId: number | null; payFull?: boolean },
  ) {
    const purchase = await (async () => {
      const { status, body } = await postJson(baseUrl, ctx, "/api/purchases", {
        items: [{ variantId, quantity: qty, purchasePrice: unitCost }],
        supplierId: opts.supplierId,
        purchaseDate: new Date().toISOString(),
      });
      assert.equal(status, 201, `purchase create failed: ${JSON.stringify(body)}`);
      return { id: Number(body.data.id) };
    })();

    const { rows } = await pg!.query(
      `SELECT id, variant_id, quantity, received_quantity
       FROM purchase_items WHERE purchase_id = $1 ORDER BY id`,
      [purchase.id],
    );
    const items = rows as {
      id: number;
      variant_id: number;
      quantity: string;
      received_quantity: string;
    }[];

    const received = await postJson(baseUrl, ctx, "/api/purchases/receive", {
      purchaseId: purchase.id,
      items: items.map((row) => ({
        itemId: row.id,
        trackingType: "none",
        receiveNow: qty,
        unitCost,
        sellingPrice: 100,
        batches: [],
        serialNumbers: [],
      })),
      paymentAmount: opts.payFull ? qty * unitCost : 0,
      paymentMethod: "cash",
    });
    assert.equal(received.status, 201, `receive failed: ${JSON.stringify(received.body)}`);

    return { purchaseId: purchase.id, items };
  }

  async function returnItems(
    ctx: OwnerCtx,
    purchaseId: number,
    changedItems: { purchaseItemId: number; quantity: number }[],
    reason = "damaged in transit",
  ) {
    return postJson(baseUrl, ctx, "/api/purchase-return", {
      orderId: purchaseId,
      reason,
      changedItems,
    });
  }

  async function receiveSession(
    ctx: OwnerCtx,
    purchaseId: number,
    plan: { itemId: number; receiveNow: number; unitCost: number }[],
  ) {
    const received = await postJson(baseUrl, ctx, "/api/purchases/receive", {
      purchaseId,
      items: plan.map((entry) => ({
        itemId: entry.itemId,
        trackingType: "none",
        receiveNow: entry.receiveNow,
        unitCost: entry.unitCost,
        sellingPrice: 100,
        batches: [],
        serialNumbers: [],
      })),
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(received.status, 201, `receive failed: ${JSON.stringify(received.body)}`);
  }

  it("credits returns at each unit's batch receive cost across sessions (D1)", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return D1 Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    // 10 ordered @ 100; received 4 @ 100 (session 1) + 6 @ 200 (session 2).
    const { status, body } = await postJson(baseUrl, owner, "/api/purchases", {
      items: [{ variantId, quantity: 10, purchasePrice: 100 }],
      supplierId,
      purchaseDate: new Date().toISOString(),
    });
    assert.equal(status, 201, `purchase create failed: ${JSON.stringify(body)}`);
    const purchaseId = Number(body.data.id);
    const { rows } = await pg!.query(
      "SELECT id FROM purchase_items WHERE purchase_id = $1 ORDER BY id",
      [purchaseId],
    );
    const itemId = (rows[0] as { id: number }).id;

    await receiveSession(owner, purchaseId, [
      { itemId, receiveNow: 4, unitCost: 100 },
    ]);
    await receiveSession(owner, purchaseId, [
      { itemId, receiveNow: 6, unitCost: 200 },
    ]);

    // Return 2 (FIFO → both from the first batch @ 100): credit 200.
    const first = await returnItems(owner, purchaseId, [
      { purchaseItemId: itemId, quantity: 2 },
    ]);
    assert.equal(first.status, 201, `return 1 failed: ${JSON.stringify(first.body)}`);
    assert.equal(Number(first.body?.data?.totalAmount), 200);
    // Landed-cost feedback is always present (no document → not adjusted),
    // with the authoritative state explanation (Phase 7).
    assert.deepEqual(first.body?.data?.landedCost, {
      adjusted: false,
      amount: 0,
      documentId: null,
      state: "no_document",
      reason: "No landed-cost document exists for this purchase.",
    });

    // Return 8 more (remaining 2 @ 100 + 6 @ 200): credit 1400.
    const second = await returnItems(owner, purchaseId, [
      { purchaseItemId: itemId, quantity: 8 },
    ]);
    assert.equal(second.status, 201, `return 2 failed: ${JSON.stringify(second.body)}`);
    assert.equal(Number(second.body?.data?.totalAmount), 1400);

    // Supplier ledger credits match the batch-authoritative figures.
    const ledger = (await pg!.query(
      `SELECT credit FROM supplier_ledger WHERE business_id = $1 AND supplier_id = $2
       ORDER BY id`,
      [owner.businessId, supplierId],
    )).rows as { credit: string }[];
    assert.deepEqual(ledger.map((row) => Number(row.credit)), [200, 1400]);

    // Batches are drained: 0 remaining on both receive sessions' batches.
    const batches = (await pg!.query(
      `SELECT quantity_received, quantity_remaining FROM inventory_batches
       WHERE purchase_item_id = $1 AND business_id = $2 ORDER BY id`,
      [itemId, owner.businessId],
    )).rows as { quantity_received: string; quantity_remaining: string }[];
    assert.deepEqual(
      batches.map((b) => [Number(b.quantity_received), Number(b.quantity_remaining)]),
      [
        [4, 0],
        [6, 0],
      ],
    );

    // Line cost stays the PO cost (100) — never overwritten.
    const line = (await pg!.query(
      "SELECT unit_cost FROM purchase_items WHERE id = $1",
      [itemId],
    )).rows[0] as { unit_cost: string };
    assert.equal(Number(line.unit_cost), 100);

    // Payable reduced by the credits, clamped at zero (1000 − 200 − 1400).
    const header = (await pg!.query(
      "SELECT due_amount FROM purchases WHERE id = $1",
      [purchaseId],
    )).rows[0] as { due_amount: string };
    assert.equal(Number(header.due_amount), 0);
  });

  it("reconciles a full-line return to the net line value with line discount and tax (D1)", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return Net Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    // Line: 10 @ 100 with a 50 discount and 20 tax → net line value 970.
    const { status, body } = await postJson(baseUrl, owner, "/api/purchases", {
      items: [
        { variantId, quantity: 10, purchasePrice: 100, discount: 50, tax: 20 },
      ],
      supplierId,
      purchaseDate: new Date().toISOString(),
    });
    assert.equal(status, 201, `purchase create failed: ${JSON.stringify(body)}`);
    const purchaseId = Number(body.data.id);
    const { rows } = await pg!.query(
      "SELECT id FROM purchase_items WHERE purchase_id = $1 ORDER BY id",
      [purchaseId],
    );
    const itemId = (rows[0] as { id: number }).id;
    await receiveSession(owner, purchaseId, [
      { itemId, receiveNow: 10, unitCost: 100 },
    ]);

    const ret = await returnItems(owner, purchaseId, [
      { purchaseItemId: itemId, quantity: 10 },
    ]);
    assert.equal(ret.status, 201, `return failed: ${JSON.stringify(ret.body)}`);
    // Full-line invariant: credit = net line value (batch cost 100/unit
    // plus amortized tax − discount = 97/unit).
    assert.equal(Number(ret.body?.data?.totalAmount), 970);

    const returnItem = (await pg!.query(
      "SELECT unit_price FROM purchase_return_items WHERE purchase_item_id = $1",
      [itemId],
    )).rows[0] as { unit_price: string };
    assert.equal(Number(returnItem.unit_price), 97);
  });

  it("returns received stock, credits the supplier ledger, reduces the due", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return Core Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const { purchaseId, items } = await createReceivedPurchase(
      owner,
      variantId,
      3,
      50,
      { supplierId },
    );

    const { status, body } = await returnItems(owner, purchaseId, [
      { purchaseItemId: items[0]!.id, quantity: 1 },
    ]);
    assert.equal(status, 201, `return failed: ${JSON.stringify(body)}`);
    assert.equal(Number(body?.data?.totalAmount), 50);
    const returnId = Number(body?.data?.purchaseReturnId);
    assert.ok(returnId > 0);

    const stock = await stockRow(owner.businessId, variantId);
    assert.equal(stock?.quantity, 2); // received 3, returned 1

    const movement = (await pg!.query(
      `SELECT quantity FROM inventory_movements
       WHERE movement_type = 'adjustment' AND reference_type = 'purchase_return'
         AND reference_id = $1`,
      [returnId],
    )).rows[0] as { quantity: number } | undefined;
    assert.ok(movement, "purchase_return movement row missing");
    assert.equal(Number(movement.quantity), -1);

    const ledger = (await pg!.query(
      `SELECT credit FROM supplier_ledger
       WHERE supplier_id = $1 AND transaction_type = 'PURCHASE_RETURN'
         AND reference_id = $2`,
      [supplierId, returnId],
    )).rows[0] as { credit: string } | undefined;
    assert.ok(ledger, "supplier ledger credit row missing");
    assert.equal(Number(ledger.credit), 50);

    const header = (await pg!.query(
      "SELECT due_amount FROM purchases WHERE id = $1",
      [purchaseId],
    )).rows[0] as { due_amount: string };
    assert.equal(Number(header.due_amount), 100); // 150 total − 50 returned
  });

  it("rejects returning more than the received units remain eligible", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return Eligible Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const { purchaseId, items } = await createReceivedPurchase(
      owner,
      variantId,
      2,
      50,
      { supplierId },
    );

    const first = await returnItems(owner, purchaseId, [
      { purchaseItemId: items[0]!.id, quantity: 2 },
    ]);
    assert.equal(first.status, 201);

    const second = await returnItems(owner, purchaseId, [
      { purchaseItemId: items[0]!.id, quantity: 1 },
    ]);
    assert.equal(second.status, 400);
    assert.match(
      String(second.body?.message),
      /only 0 received units remain eligible/,
    );
  });

  it("rejects returning more than is on hand", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return OnHand Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const { purchaseId, items } = await createReceivedPurchase(
      owner,
      variantId,
      2,
      50,
      { supplierId },
    );

    // Drain the shelf independently of the return flow.
    const adjust = await postJson(
      baseUrl,
      owner,
      `/api/products/variants/${variantId}/adjust-stock`,
      { newQuantity: 0, reason: "count_correction" },
    );
    assert.equal(adjust.status, 200);

    const { status, body } = await returnItems(owner, purchaseId, [
      { purchaseItemId: items[0]!.id, quantity: 1 },
    ]);
    assert.equal(status, 400);
    assert.match(String(body?.message), /Insufficient on-hand stock/);
  });

  it("requires a supplier on the purchase", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return NoSupplier Co");
    const variantId = await seedVariant(owner.businessId);
    const { purchaseId, items } = await createReceivedPurchase(
      owner,
      variantId,
      1,
      50,
      { supplierId: null },
    );

    const { status, body } = await returnItems(owner, purchaseId, [
      { purchaseItemId: items[0]!.id, quantity: 1 },
    ]);
    assert.equal(status, 400);
    assert.match(String(body?.message), /supplier must be assigned/);
  });

  it("keeps a fully paid purchase paid after a return", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return Paid Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const { purchaseId, items } = await createReceivedPurchase(
      owner,
      variantId,
      2,
      50,
      { supplierId, payFull: true },
    );

    const { status, body } = await returnItems(owner, purchaseId, [
      { purchaseItemId: items[0]!.id, quantity: 1 },
    ]);
    assert.equal(status, 201, `return failed: ${JSON.stringify(body)}`);
    assert.equal(Number(body?.data?.totalAmount), 50);

    const header = (await pg!.query(
      "SELECT due_amount FROM purchases WHERE id = $1",
      [purchaseId],
    )).rows[0] as { due_amount: string };
    assert.equal(Number(header.due_amount), 0); // max(0, 0 − 50)
  });

  it("lists per-item return quantities", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return Items Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const { purchaseId, items } = await createReceivedPurchase(
      owner,
      variantId,
      2,
      50,
      { supplierId },
    );

    const created = await returnItems(owner, purchaseId, [
      { purchaseItemId: items[0]!.id, quantity: 1 },
    ]);
    assert.equal(created.status, 201);

    const { status, body } = await getJson(
      baseUrl,
      owner,
      `/api/purchases/return-items?orderId=${purchaseId}`,
    );
    assert.equal(status, 200, `return-items failed: ${JSON.stringify(body)}`);
    const payload = body?.data ?? body;
    const rows: { purchaseItemId: number; returnQuantity: number }[] =
      Array.isArray(payload)
        ? payload
        : (payload?.rows ?? payload?.items ?? []);
    const mine = rows.find((r) => Number(r.purchaseItemId) === items[0]!.id);
    assert.ok(mine, `return-items row missing for item ${items[0]!.id}`);
    assert.equal(Number(mine.returnQuantity), 1);
  });

  async function sellUnits(owner: OwnerCtx, variantId: number, qty: number) {
    // seedVariant seeds selling_price 100 — the sale must match it.
    const sale = await postJson(baseUrl, owner, "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: qty * 100, tendered: qty * 100 }],
      discount: null,
      vatPercent: null,
      items: [{ variantId, quantity: qty, unitPrice: 100, discount: null }],
    });
    assert.equal(sale.status, 201, `sale failed: ${JSON.stringify(sale.body)}`);
  }

  it("allows returns after partial sales, capped by remaining stock", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return AfterSale Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const { purchaseId, items } = await createReceivedPurchase(
      owner,
      variantId,
      10,
      100,
      { supplierId },
    );
    await sellUnits(owner, variantId, 4);

    // 6 remain on hand → returning 6 is allowed (credit 6 × 100).
    const ok = await returnItems(owner, purchaseId, [
      { purchaseItemId: items[0]!.id, quantity: 6 },
    ]);
    assert.equal(ok.status, 201, `return failed: ${JSON.stringify(ok.body)}`);
    assert.equal(Number(ok.body?.data?.totalAmount), 600);

    // Everything returned is gone: one more unit is refused.
    const over = await returnItems(owner, purchaseId, [
      { purchaseItemId: items[0]!.id, quantity: 1 },
    ]);
    assert.equal(over.status, 400);
    assert.match(String(over.body?.message), /Insufficient on-hand stock/);

    const batch = (await pg!.query(
      "SELECT quantity_remaining FROM inventory_batches WHERE purchase_item_id = $1",
      [items[0]!.id],
    )).rows[0] as { quantity_remaining: string };
    assert.equal(Number(batch.quantity_remaining), 0);
  });

  it("caps returns across two lines sharing one variant by the combined stock", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return TwoLines Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const { status, body } = await postJson(baseUrl, owner, "/api/purchases", {
      items: [
        { variantId, quantity: 5, purchasePrice: 100 },
        { variantId, quantity: 5, purchasePrice: 100 },
      ],
      supplierId,
      purchaseDate: new Date().toISOString(),
    });
    assert.equal(status, 201);
    const purchaseId = Number(body.data.id);
    const { rows } = await pg!.query(
      "SELECT id, received_quantity FROM purchase_items WHERE purchase_id = $1 ORDER BY id",
      [purchaseId],
    );
    const lineIds = (rows as { id: number }[]).map((r) => r.id);
    await receiveSession(owner, purchaseId, [
      { itemId: lineIds[0]!, receiveNow: 5, unitCost: 100 },
      { itemId: lineIds[1]!, receiveNow: 5, unitCost: 100 },
    ]);
    await sellUnits(owner, variantId, 6);

    // 4 units remain; demanding 5 across the two shared-variant lines
    // must be refused (stock is variant-scoped, not line-scoped).
    const over = await returnItems(owner, purchaseId, [
      { purchaseItemId: lineIds[0]!, quantity: 3 },
      { purchaseItemId: lineIds[1]!, quantity: 2 },
    ]);
    assert.equal(over.status, 400);
    assert.match(String(over.body?.message), /Insufficient on-hand stock/);

    const ok = await returnItems(owner, purchaseId, [
      { purchaseItemId: lineIds[0]!, quantity: 3 },
      { purchaseItemId: lineIds[1]!, quantity: 1 },
    ]);
    assert.equal(ok.status, 201, `return failed: ${JSON.stringify(ok.body)}`);
    assert.equal(Number(ok.body?.data?.totalAmount), 400);

    const stock = await stockRow(owner.businessId, variantId);
    assert.equal(Number(stock?.quantity ?? 0), 0);
  });

  it("rolls back the entire return when one line of several is ineligible", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return Rollback Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const { status, body } = await postJson(baseUrl, owner, "/api/purchases", {
      items: [
        { variantId, quantity: 5, purchasePrice: 100 },
        { variantId, quantity: 5, purchasePrice: 100 },
      ],
      supplierId,
      purchaseDate: new Date().toISOString(),
    });
    assert.equal(status, 201);
    const purchaseId = Number(body.data.id);
    const { rows } = await pg!.query(
      "SELECT id FROM purchase_items WHERE purchase_id = $1 ORDER BY id",
      [purchaseId],
    );
    const lineIds = (rows as { id: number }[]).map((r) => r.id);
    await receiveSession(owner, purchaseId, [
      { itemId: lineIds[0]!, receiveNow: 5, unitCost: 100 },
      { itemId: lineIds[1]!, receiveNow: 5, unitCost: 100 },
    ]);

    // Line 1 is eligible, line 2 over-returns its received quantity.
    const bad = await returnItems(owner, purchaseId, [
      { purchaseItemId: lineIds[0]!, quantity: 2 },
      { purchaseItemId: lineIds[1]!, quantity: 7 },
    ]);
    assert.equal(bad.status, 400);
    assert.match(String(bad.body?.message), /remain eligible/);

    // One transaction: no return row, no ledger credit, nothing deducted.
    const returnRows = await pg!.query(
      "SELECT id FROM purchase_returns WHERE purchase_id = $1",
      [purchaseId],
    );
    assert.equal(returnRows.rows.length, 0);
    const ledger = await pg!.query(
      "SELECT id FROM supplier_ledger WHERE business_id = $1 AND supplier_id = $2",
      [owner.businessId, supplierId],
    );
    assert.equal(ledger.rows.length, 0);
    for (const lineId of lineIds) {
      const batch = (await pg!.query(
        "SELECT quantity_remaining FROM inventory_batches WHERE purchase_item_id = $1",
        [lineId],
      )).rows[0] as { quantity_remaining: string };
      assert.equal(Number(batch.quantity_remaining), 5);
    }
    const stock = await stockRow(owner.businessId, variantId);
    assert.equal(Number(stock?.quantity ?? 0), 10);
  });

  it("evaluates return eligibility at the RECEIVING location, not the active location (Phase 1)", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return Cross-Loc Co");
    // A second location for the business — the caller's ACTIVE location.
    const second = await postJson(baseUrl, owner, "/api/locations", {
      name: `Second Store ${Date.now()}`,
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const activeLocationId = Number(second.body.data.id);

    const defaultLocation = (await pg!.query(
      "SELECT id, name FROM locations WHERE business_id = $1 AND is_default = true",
      [owner.businessId],
    )).rows[0] as { id: number; name: string };

    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const { purchaseId, items } = await createReceivedPurchase(
      owner,
      variantId,
      10,
      100,
      { supplierId },
    );
    const itemId = Number(items[0]!.id);

    // Sell 2 units → 8 remain at the RECEIVING location (the default).
    await sellUnits(owner, variantId, 2);

    // Detail read with the ACTIVE location pointing at the empty store:
    // the return context must still evaluate the RECEIVING location.
    const detail = await getJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}`,
      { "x-location-id": String(activeLocationId) },
    );
    assert.equal(detail.status, 200);
    const context = (detail.body as any).returnContext;
    assert.equal(context.locationId, defaultLocation.id);
    assert.equal(context.locationName, defaultLocation.name);
    assert.equal(context.canReturn, true);
    assert.equal(context.reason, null);
    assert.equal(context.items.length, 1);
    assert.equal(context.items[0].purchaseItemId, itemId);
    assert.equal(context.items[0].orderedQuantity, 10);
    assert.equal(context.items[0].receivedQuantity, 10);
    assert.equal(context.items[0].returnedQuantity, 0);
    // The receiving location has 8 — NOT the active location's 0.
    assert.equal(context.items[0].availableStock, 8);

    // The old data source (business-wide items at the ACTIVE location)
    // reports no stock there — exactly why the page must not use it.
    const itemsResp = await getJson(baseUrl, owner, "/api/purchases/items", {
      "x-location-id": String(activeLocationId),
    });
    assert.equal(itemsResp.status, 200);
    const activeLocationStock = (itemsResp.body as any[]).find(
      (row) => row.purchaseId === purchaseId,
    ).availableStock;
    assert.ok(!activeLocationStock, "active-location stock must not feed returns");

    // A return processed while the ACTIVE location differs still deducts
    // at the receiving location, and the context reflects the new state.
    const ret = await postJson(
      baseUrl,
      owner,
      "/api/purchase-return",
      {
        orderId: purchaseId,
        reason: "phase 1 cross-location",
        changedItems: [{ purchaseItemId: itemId, quantity: 3 }],
      },
      { "x-location-id": String(activeLocationId) },
    );
    assert.equal(ret.status, 201, JSON.stringify(ret.body));

    const after = await getJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}`,
      { "x-location-id": String(activeLocationId) },
    );
    const contextAfter = (after.body as any).returnContext;
    assert.equal(contextAfter.items[0].returnedQuantity, 3);
    assert.equal(contextAfter.items[0].availableStock, 5);
    assert.equal((after.body as any).purchase.returnStatus, "Partially returned");
  });

  /* ------------------------------------------------------------------
   * Phase 2 — server-authoritative return preview: the preview computes
   * the SAME batch-FIFO credit math the committing return uses (shared
   * pure helpers), reports landed-cost state per the document, splits
   * supplier balance vs credit, and REPORTS (not throws) eligibility
   * issues. Preview totals equal the commit's actual totals.
   * ------------------------------------------------------------------ */

  it("previews the return at real batch costs with landed reversal and balance split (Phase 2)", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return Preview Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);

    // Line with a discount and tax: amortized adjustment = (tax − disc)/qty.
    const purchase = await postJson(baseUrl, owner, "/api/purchases", {
      items: [
        {
          variantId,
          quantity: 10,
          purchasePrice: 100,
          discount: 20,
          tax: 10,
        },
      ],
      supplierId,
      purchaseDate: new Date().toISOString(),
    });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.body));
    const purchaseId = Number(purchase.body.data.id);
    const { rows: itemRows } = await pg!.query(
      "SELECT id FROM purchase_items WHERE purchase_id = $1",
      [purchaseId],
    );
    const itemId = Number(itemRows[0]!.id);

    // Two receive sessions at different costs → two batches.
    await receiveSession(owner, purchaseId, [{ itemId, receiveNow: 5, unitCost: 100 }]);
    await receiveSession(owner, purchaseId, [{ itemId, receiveNow: 5, unitCost: 120 }]);
    // Landed cost: 500 → 50/unit on both batches; posted so a reversal applies.
    const doc = await postJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}/landed-cost`,
      {
        method: "quantity",
        expenses: [
          { expenseType: "customs", amount: 500, isCapitalizable: true },
        ],
      },
    );
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const docId = Number(doc.body.data.id);
    assert.equal(
      (await postJson(baseUrl, owner, `/api/landed-costs/${docId}/post`, {}))
        .status,
      200,
    );

    // Preview a 7-unit return: FIFO → 5 @ 100 + 2 @ 120.
    // Per-unit credit = batch price + (10 − 20)/10 = price − 1.
    const preview = await postJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}/return-preview`,
      { changedItems: [{ purchaseItemId: itemId, quantity: 7 }] },
    );
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const data = (preview.body as any).data;
    assert.equal(data.canSubmit, true);
    assert.deepEqual(data.issues, []);
    // Goods credit: 5 × 99 + 2 × 119 = 733.
    assert.equal(data.goodsCredit.total, 733);
    assert.equal(data.goodsCredit.lineCredits[0].goodsCredit, 733);
    // Batch breakdown: two batches, FIFO quantities.
    assert.equal(data.inventory.batchBreakdown.length, 2);
    assert.equal(data.inventory.batchBreakdown[0].quantity, 5);
    assert.equal(Number(data.inventory.batchBreakdown[0].unitCost), 100);
    assert.equal(Number(data.inventory.batchBreakdown[1].unitCost), 120);
    // Landed reversal applies (posted doc): 7 × 50 = 350.
    assert.equal(data.landedCost.applies, true);
    assert.equal(data.landedCost.state, "posted");
    assert.equal(data.landedCost.expectedReversal, 350);
    // Inventory valuation reduction = full landed cost: 5 × 150 + 2 × 170 = 1090.
    assert.equal(data.inventory.valuationReduction, 1090);
    // Supplier balance: due 0 (nothing paid, but due = grand 990? compute:
    // grand = 10×100 − 20 + 10 = 990; payment 0 → due 990). Credit 733 < 990
    // → outstanding drops, no credit balance created.
    assert.equal(data.supplierBalance.outstandingBefore, 990);
    assert.equal(data.supplierBalance.outstandingAfter, 257);
    assert.equal(data.supplierBalance.supplierCreditCreated, 0);
    // Quantities block.
    assert.equal(data.quantities[0].eligibleQuantity, 10);
    assert.equal(data.quantities[0].requestedQuantity, 7);
    assert.equal(data.quantities[0].remainingAfterReturn, 3);
    assert.equal(data.quantities[0].availableStock, 10);

    // CONSISTENCY: committing the same return pays exactly the preview.
    const commit = await returnItems(owner, purchaseId, [
      { purchaseItemId: itemId, quantity: 7 },
    ], "phase 2 preview consistency");
    assert.equal(commit.status, 201, JSON.stringify(commit.body));
    assert.equal(Number((commit.body as any).data.totalAmount), 733);
    // The landed reversal also matches the preview.
    assert.equal(Number((commit.body as any).data.landedCost.amount), 350);
    // Phase 7: the response names the document state (authoritative).
    assert.equal((commit.body as any).data.landedCost.state, "adjusted");
    assert.equal((commit.body as any).data.landedCost.reason, null);
    // Phase 3: the credit split rides the commit response.
    const balance = (commit.body as any).data.supplierBalance;
    assert.equal(balance.outstandingBefore, 990);
    assert.equal(balance.goodsCredit, 733);
    assert.equal(balance.outstandingAfter, 257);
    assert.equal(balance.supplierCreditCreated, 0);
  });

  it("reports eligibility issues and landed states instead of throwing (Phase 2)", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return Preview Issues Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const { purchaseId, items } = await createReceivedPurchase(
      owner,
      variantId,
      10,
      100,
      { supplierId, payFull: true },
    );
    const itemId = Number(items[0]!.id);

    // Over-request: 12 of 10 → the preview REPORTS, canSubmit false.
    const over = await postJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}/return-preview`,
      { changedItems: [{ purchaseItemId: itemId, quantity: 12 }] },
    );
    assert.equal(over.status, 200, JSON.stringify(over.body));
    const overData = (over.body as any).data;
    assert.equal(overData.canSubmit, false);
    assert.ok(overData.issues.length > 0, "issues must be reported");
    assert.equal(overData.quantities[0].eligibleQuantity, 10);
    assert.equal(overData.quantities[0].requestedQuantity, 12);

    // Fully paid purchase → the whole credit becomes supplier credit.
    const ok = await postJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}/return-preview`,
      { changedItems: [{ purchaseItemId: itemId, quantity: 4 }] },
    );
    const okData = (ok.body as any).data;
    assert.equal(okData.canSubmit, true);
    assert.equal(okData.supplierBalance.outstandingBefore, 0);
    assert.equal(okData.supplierBalance.outstandingAfter, 0);
    assert.equal(okData.supplierBalance.supplierCreditCreated, 400);
    // No landed-cost document → not applicable.
    assert.equal(okData.landedCost.applies, false);
    assert.equal(okData.landedCost.state, "no_document");

    // DRAFT document → nothing capitalized to reverse.
    const doc = await postJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}/landed-cost`,
      {
        method: "quantity",
        expenses: [
          { expenseType: "customs", amount: 200, isCapitalizable: true },
        ],
      },
    );
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const draft = await postJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}/return-preview`,
      { changedItems: [{ purchaseItemId: itemId, quantity: 4 }] },
    );
    const draftData = (draft.body as any).data;
    assert.equal(draftData.landedCost.applies, false);
    assert.equal(draftData.landedCost.state, "draft");
    assert.equal(draftData.landedCost.expectedReversal, 0);
    assert.ok(draftData.landedCost.reason);

    // Committing on the fully paid purchase: the whole credit becomes a
    // SUPPLIER CREDIT BALANCE — the purchase stays settled, the money is
    // never treated as a cash refund.
    const commit = await returnItems(owner, purchaseId, [
      { purchaseItemId: itemId, quantity: 4 },
    ], "phase 3 credit balance");
    assert.equal(commit.status, 201, JSON.stringify(commit.body));
    const committed = (commit.body as any).data;
    assert.equal(committed.supplierBalance.outstandingBefore, 0);
    assert.equal(committed.supplierBalance.outstandingAfter, 0);
    assert.equal(committed.supplierBalance.supplierCreditCreated, 400);
    // Phase 7: the DRAFT document explains why nothing was reversed.
    assert.equal(committed.landedCost.adjusted, false);
    assert.equal(committed.landedCost.state, "draft");
    assert.match(
      String(committed.landedCost.reason),
      /nothing is capitalized yet/,
    );
    const headerAfter = await pg!.query(
      "SELECT due_amount, payment_status FROM purchases WHERE id = $1",
      [purchaseId],
    );
    assert.equal(Number(headerAfter.rows[0]!.due_amount), 0);
    assert.equal(headerAfter.rows[0]!.payment_status, "paid");

    // The purchase detail surfaces the supplier's credit balance.
    const detail = await getJson(baseUrl, owner, `/api/purchases/${purchaseId}`);
    assert.equal(
      Number((detail.body as any).purchase.supplierCreditBalance),
      400,
    );
  });

  /* ------------------------------------------------------------------
   * Phase 5 - explicit serial selection: the picker endpoint lists
   * in-stock serials per serial-tracked line; the commit accepts
   * per-line serialIds, re-validates every id transactionally, and
   * preserves the auto-pick fallback. The response reports the serial
   * numbers actually marked returned.
   * ------------------------------------------------------------------ */

  it("lists returnable serials and returns explicitly selected serials (Phase 5)", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return Serial Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedSerialVariant(owner.businessId);
    const serialsIn = ["SN-A-1", "SN-A-2", "SN-A-3"];
    const { purchaseId, itemId } = await createReceivedSerialPurchase(
      owner,
      variantId,
      serialsIn,
      { supplierId },
    );

    // The picker lists exactly the three in-stock serials for this line.
    const listing = await getJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}/return-serials`,
    );
    assert.equal(listing.status, 200, JSON.stringify(listing.body));
    const listingData = (listing.body as any).data;
    assert.equal(listingData.items.length, 1);
    assert.equal(listingData.items[0].purchaseItemId, itemId);
    assert.deepEqual(
      listingData.items[0].serials.map((s: any) => s.serialNumber),
      serialsIn,
    );
    const serialIds = listingData.items[0].serials.map((s: any) => s.id);

    // Explicit selection: return SN-A-2 and SN-A-3 by id.
    const ret = await postJson(baseUrl, owner, "/api/purchase-return", {
      orderId: purchaseId,
      reason: "phase 5 explicit serials",
      changedItems: [
        {
          purchaseItemId: itemId,
          quantity: 2,
          serialIds: [serialIds[1], serialIds[2]],
        },
      ],
    });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));
    const committed = (ret.body as any).data;
    // Response traceability: exactly the selected serial numbers.
    assert.deepEqual(committed.returnedSerials, ["SN-A-2", "SN-A-3"]);

    // The selected serials are 'returned'; the untouched one stays in stock.
    const statuses = await pg!.query(
      "SELECT serial_number, status FROM serial_numbers WHERE purchase_item_id = $1 ORDER BY id",
      [itemId],
    );
    const bySerial = new Map(
      (statuses.rows as any[]).map((r) => [r.serial_number, r.status]),
    );
    assert.equal(bySerial.get("SN-A-1"), "in_stock");
    assert.equal(bySerial.get("SN-A-2"), "returned");
    assert.equal(bySerial.get("SN-A-3"), "returned");
  });

  it("re-validates explicit serial selections and preserves the auto-pick fallback (Phase 5)", async () => {
    const owner = await createOwnerCtx(baseUrl, "Return Serial Guard Co");
    const supplierId = await createSupplier(owner);
    const variantId = await seedSerialVariant(owner.businessId);
    const { purchaseId, itemId } = await createReceivedSerialPurchase(
      owner,
      variantId,
      ["SN-B-1", "SN-B-2"],
      { supplierId },
    );
    const { rows: serialRows } = await pg!.query(
      "SELECT id, serial_number FROM serial_numbers WHERE purchase_item_id = $1 ORDER BY id",
      [itemId],
    );
    const serialId1 = Number(serialRows[0]!.id);
    const serialId2 = Number(serialRows[1]!.id);

    // Count mismatch: 2 serials for quantity 1.
    const mismatch = await postJson(baseUrl, owner, "/api/purchase-return", {
      orderId: purchaseId,
      changedItems: [
        { purchaseItemId: itemId, quantity: 1, serialIds: [serialId1, serialId2] },
      ],
    });
    assert.equal(mismatch.status, 400, JSON.stringify(mismatch.body));
    assert.match(
      String((mismatch.body as any).message),
      /must match the return quantity/,
    );

    // A serial from ANOTHER purchase line is not eligible.
    const otherVariant = await seedSerialVariant(owner.businessId);
    const other = await createReceivedSerialPurchase(
      owner,
      otherVariant,
      ["SN-OTHER-1"],
      { supplierId },
    );
    const { rows: otherSerialRows } = await pg!.query(
      "SELECT id FROM serial_numbers WHERE purchase_item_id = $1",
      [other.itemId],
    );
    const foreign = await postJson(baseUrl, owner, "/api/purchase-return", {
      orderId: purchaseId,
      changedItems: [
        { purchaseItemId: itemId, quantity: 1, serialIds: [Number(otherSerialRows[0]!.id)] },
      ],
    });
    assert.equal(foreign.status, 400, JSON.stringify(foreign.body));
    assert.match(
      String((foreign.body as any).message),
      /not eligible for return/,
    );

    // Auto-pick fallback: no serialIds -> first in-stock serials by id.
    const fallback = await postJson(baseUrl, owner, "/api/purchase-return", {
      orderId: purchaseId,
      changedItems: [{ purchaseItemId: itemId, quantity: 1 }],
    });
    assert.equal(fallback.status, 201, JSON.stringify(fallback.body));
    assert.deepEqual((fallback.body as any).data.returnedSerials, ["SN-B-1"]);

    // A serial already marked returned is not eligible afterwards.
    const reuse = await postJson(baseUrl, owner, "/api/purchase-return", {
      orderId: purchaseId,
      changedItems: [
        { purchaseItemId: itemId, quantity: 1, serialIds: [serialId1] },
      ],
    });
    assert.equal(reuse.status, 400, JSON.stringify(reuse.body));
    assert.match(
      String((reuse.body as any).message),
      /not eligible for return/,
    );
  });
});
