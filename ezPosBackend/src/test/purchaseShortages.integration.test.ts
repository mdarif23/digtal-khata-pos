/**
 * Short-receiving resolution integration tests (Phase 3): the three
 * resolutions (receive-later / cancel / backordered), outstanding-aware
 * status, payable + ledger + due-management consistency, landed-cost
 * pending exclusion for cancelled quantities, and rollback — against a
 * REAL PostgreSQL database. Double-guarded like the other suites.
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

describe("purchase shortage resolution integration", { skip: !runIntegration }, () => {
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

  async function seedVariant(businessId: number): Promise<number> {
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
       VALUES ($1, $2, $3, 150, true, 'active') RETURNING id`,
      [businessId, product.rows[0]!.id, `SKU-${Date.now()}-${(counter += 1)}`],
    );
    await pg!.query(
      `INSERT INTO inventory_stock (business_id, variant_id, location_id, quantity, reserved_quantity)
       VALUES ($1, $2, $3, 0, 0)`,
      [businessId, variant.rows[0]!.id, location.id],
    );
    return variant.rows[0]!.id as number;
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
    return Number(body?.data?.supplierId);
  }

  async function createPurchase(
    ctx: OwnerCtx,
    supplierId: number | null,
    variantId: number,
    qty: number,
    price: number,
  ): Promise<number> {
    const { status, body } = await postJson(baseUrl, ctx, "/api/purchases", {
      items: [{ variantId, quantity: qty, purchasePrice: price }],
      supplierId,
      purchaseDate: new Date().toISOString(),
    });
    assert.equal(status, 201, `purchase create failed: ${JSON.stringify(body)}`);
    return Number(body.data.id);
  }

  async function purchaseItemId(purchaseId: number): Promise<number> {
    const { rows } = await pg!.query(
      "SELECT id FROM purchase_items WHERE purchase_id = $1 ORDER BY id",
      [purchaseId],
    );
    return (rows[0] as { id: number }).id;
  }

  async function receive(
    ctx: OwnerCtx,
    purchaseId: number,
    itemId: number,
    receiveNow: number,
    unitCost: number,
  ) {
    const res = await postJson(baseUrl, ctx, "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow,
          unitCost,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(res.status, 201, `receive failed: ${JSON.stringify(res.body)}`);
  }

  async function resolveOutstanding(
    ctx: OwnerCtx,
    purchaseId: number,
    itemId: number,
    quantity: number,
    resolution: string,
    reason?: string,
  ) {
    return postJson(
      baseUrl,
      ctx,
      `/api/purchases/${purchaseId}/outstanding-resolution`,
      {
        items: [{ purchaseItemId: itemId, quantity, resolution, reason }],
      },
    );
  }

  async function dbRows(query: string, params: unknown[] = []) {
    const { rows } = await pg!.query(query, params as never[]);
    return rows;
  }

  it("cancels outstanding quantity: excluded from outstanding, payable drops, status completes", async () => {
    const owner = await createOwnerCtx(baseUrl, `Shortage Cancel ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchaseId = await createPurchase(owner, supplierId, variantId, 10, 100);
    const itemId = await purchaseItemId(purchaseId);
    await receive(owner, purchaseId, itemId, 8, 100);

    const res = await resolveOutstanding(
      owner,
      purchaseId,
      itemId,
      2,
      "cancel",
      "Supplier cannot fulfil the remainder",
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(Number(res.body?.data?.cancelledValue), 200);
    assert.equal(Number(res.body?.data?.dueAmount), 800);
    assert.equal(res.body?.data?.status, "received"); // nothing outstanding

    // Phase 3: this PO accepted 8 goods, so it is NOT fullyCancelled...
    const list = (await getJson(baseUrl, owner, "/api/purchases")).body as any;
    const listed = list.allPurchases.find((p: any) => p.id === purchaseId);
    assert.equal(listed.fullyCancelled, false);

    // ...but a purchase cancelled with ZERO accepted goods is: workflow-
    // complete (status "received") without anything physically arriving.
    const emptyPo = await createPurchase(owner, supplierId, variantId, 10, 100);
    const emptyItemId = await purchaseItemId(emptyPo);
    const emptyCancel = await resolveOutstanding(
      owner,
      emptyPo,
      emptyItemId,
      10,
      "cancel",
      "order cancelled before shipment",
    );
    assert.equal(emptyCancel.status, 200, JSON.stringify(emptyCancel.body));
    const listAfter = (await getJson(baseUrl, owner, "/api/purchases")).body as any;
    const emptyListed = listAfter.allPurchases.find((p: any) => p.id === emptyPo);
    assert.equal(emptyListed.fullyCancelled, true);
    assert.equal(emptyListed.status, "received"); // workflow state (unchanged enum)
    assert.equal(Number(emptyListed.dueAmount), 0); // payable fully written off

    const line = (await dbRows(
      `SELECT quantity, received_quantity, cancelled_quantity, delivered_quantity
       FROM purchase_items WHERE id = $1`,
      [itemId],
    ))[0] as Record<string, string>;
    assert.equal(Number(line.quantity), 10); // ordered preserved
    assert.equal(Number(line.received_quantity), 8);
    assert.equal(Number(line.cancelled_quantity), 2);
    assert.equal(Number(line.delivered_quantity), 8);

    // No stock for missing goods; receiving records preserved.
    const stock = await dbRows(
      "SELECT quantity FROM inventory_stock WHERE business_id = $1 AND variant_id = $2",
      [owner.businessId, variantId],
    );
    assert.equal(Number(stock[0].quantity), 8);
    const records = await dbRows(
      "SELECT accepted_quantity FROM purchase_receiving_records WHERE purchase_item_id = $1",
      [itemId],
    );
    assert.equal(records.length, 1);
    assert.equal(Number(records[0].accepted_quantity), 8);

    // Payable trail: ledger credit + due-management consistency.
    const ledger = await dbRows(
      `SELECT transaction_type, credit FROM supplier_ledger
       WHERE business_id = $1 AND supplier_id = $2 AND reference_id = $3
       ORDER BY id`,
      [owner.businessId, supplierId, purchaseId],
    );
    assert.deepEqual(
      ledger.map((row) => [row.transaction_type, Number(row.credit)]),
      [["PURCHASE_CANCELLATION", 200]],
    );

    const summary = (await getJson(baseUrl, owner, "/api/due-management/summary?overdueDays=30")).body as any;
    assert.equal(Math.round(Number(summary.supplierOutstanding)), 800);

    // Ledger view shows the cancellation and balances to 800.
    const ledgerView = (await getJson(
      baseUrl,
      owner,
      `/api/due-management/supplier-ledger/${supplierId}`,
    )).body as any;
    const cancellation = (ledgerView.transactions as any[]).find(
      (t) => t.type === "cancellation",
    );
    assert.ok(cancellation, "cancellation row missing from ledger view");
    assert.equal(Number(cancellation.credit), 200);
    assert.equal(Number(ledgerView.totals.closing), 800);
  });

  it("records receive-later and backordered without touching quantities or payable", async () => {
    for (const resolution of ["receive_later", "backordered"] as const) {
      const owner = await createOwnerCtx(
        baseUrl,
        `Shortage ${resolution} ${Date.now()}`,
      );
      const supplierId = await createSupplier(owner);
      const variantId = await seedVariant(owner.businessId);
      const purchaseId = await createPurchase(owner, supplierId, variantId, 10, 100);
      const itemId = await purchaseItemId(purchaseId);
      await receive(owner, purchaseId, itemId, 8, 100);

      const res = await resolveOutstanding(
        owner,
        purchaseId,
        itemId,
        2,
        resolution,
        `${resolution} note`,
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(Number(res.body?.data?.cancelledValue), 0);
      assert.equal(Number(res.body?.data?.dueAmount), 1000); // untouched
      assert.equal(res.body?.data?.status, "partially_received");

      const line = (await dbRows(
        "SELECT cancelled_quantity, received_quantity FROM purchase_items WHERE id = $1",
        [itemId],
      ))[0] as Record<string, string>;
      assert.equal(Number(line.cancelled_quantity), 0);
      assert.equal(Number(line.received_quantity), 8);

      const discrepancy = (await dbRows(
        `SELECT type, resolution, status, quantity FROM purchase_discrepancies
         WHERE purchase_item_id = $1 ORDER BY id DESC`,
        [itemId],
      ))[0] as Record<string, unknown>;
      assert.equal(discrepancy.type, "shortage");
      assert.equal(discrepancy.resolution, resolution);
      assert.equal(discrepancy.status, "resolved");
      assert.equal(Number(discrepancy.quantity), 2);
    }
  });

  it("treats receiving a cancelled quantity as over-receiving", async () => {
    const owner = await createOwnerCtx(baseUrl, `Shortage ReShip ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchaseId = await createPurchase(owner, supplierId, variantId, 10, 100);
    const itemId = await purchaseItemId(purchaseId);
    await receive(owner, purchaseId, itemId, 8, 100);
    await resolveOutstanding(owner, purchaseId, itemId, 2, "cancel", "closing");

    // Cancelling the outstanding quantity completes the line — the
    // purchase is workflow-complete and CLOSED to receiving. A cancelled
    // quantity is a write-off, not a standing order; late shipments go on
    // a new purchase order.
    const closed = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: 1,
          unitCost: 100,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
          overReceiveReason: "supplier shipped the cancelled unit anyway",
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(closed.status, 409);
    assert.match(
      String(closed.body?.message),
      /already been completely received/,
    );

    // Nothing changed.
    const line = (await dbRows(
      "SELECT received_quantity, cancelled_quantity FROM purchase_items WHERE id = $1",
      [itemId],
    ))[0] as Record<string, string>;
    assert.equal(Number(line.received_quantity), 8);
    assert.equal(Number(line.cancelled_quantity), 2);
  });

  it("refuses resolving more than outstanding and rolls multi-item resolutions back", async () => {
    const owner = await createOwnerCtx(baseUrl, `Shortage Rollback ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const { status: poStatus, body: poBody } = await postJson(
      baseUrl,
      owner,
      "/api/purchases",
      {
        items: [
          { variantId, quantity: 5, purchasePrice: 100 },
          { variantId, quantity: 5, purchasePrice: 100 },
        ],
        supplierId,
        purchaseDate: new Date().toISOString(),
      },
    );
    assert.equal(poStatus, 201);
    const purchaseId = Number(poBody.data.id);
    const { rows } = await pg!.query(
      "SELECT id FROM purchase_items WHERE purchase_id = $1 ORDER BY id",
      [purchaseId],
    );
    const lineIds = (rows as { id: number }[]).map((r) => r.id);
    await receive(owner, purchaseId, lineIds[0]!, 5, 100); // line 1 fully received

    // Line 1 has nothing outstanding; line 2 demands 6 of 5.
    const bad = await postJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}/outstanding-resolution`,
      {
        items: [
          { purchaseItemId: lineIds[0], quantity: 1, resolution: "cancel" },
          { purchaseItemId: lineIds[1], quantity: 6, resolution: "cancel" },
        ],
      },
    );
    assert.equal(bad.status, 400);
    assert.match(String(bad.body?.message), /remain outstanding/);

    // One transaction: no discrepancies, no cancellations, payable intact.
    const discrepancies = await dbRows(
      "SELECT id FROM purchase_discrepancies WHERE purchase_id = $1",
      [purchaseId],
    );
    assert.equal(discrepancies.length, 0);
    const header = (await dbRows(
      "SELECT due_amount FROM purchases WHERE id = $1",
      [purchaseId],
    ))[0] as Record<string, string>;
    assert.equal(Number(header.due_amount), 1000);
    const lines = await dbRows(
      "SELECT cancelled_quantity FROM purchase_items WHERE purchase_id = $1",
      [purchaseId],
    );
    assert.deepEqual(lines.map((l) => Number(l.cancelled_quantity)), [0, 0]);
  });

  it("does not leave cancelled shares pending in landed-cost allocation", async () => {
    const owner = await createOwnerCtx(baseUrl, `Shortage LC ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchaseId = await createPurchase(owner, supplierId, variantId, 10, 100);
    const itemId = await purchaseItemId(purchaseId);
    await receive(owner, purchaseId, itemId, 8, 100);
    await resolveOutstanding(owner, purchaseId, itemId, 2, "cancel", "closing");

    // 200 capitalizable over an effective ordered basis of 8 → everything
    // allocates to the received batches; nothing stays pending.
    const doc = await postJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}/landed-cost`,
      {
        method: "quantity",
        expenses: [
          { expenseType: "shipping", amount: 200, isCapitalizable: true },
        ],
      },
    );
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const docId = Number(doc.body.data.id);
    const posted = await postJson(
      baseUrl,
      owner,
      `/api/landed-costs/${docId}/post`,
      {},
    );
    assert.equal(posted.status, 200, JSON.stringify(posted.body));

    const detail = (await getJson(baseUrl, owner, `/api/landed-costs/${docId}`)).body as any;
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 200);
    assert.equal(Number(detail.data.document.pendingAllocationAmount), 0);
    const batch = (await dbRows(
      "SELECT additional_cost_per_unit FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    ))[0] as Record<string, string>;
    assert.ok(
      Math.abs(Number(batch.additional_cost_per_unit) - 25) < 0.0001,
      `unexpected additional cost ${batch.additional_cost_per_unit}`,
    );
  });

  it("keeps the payment limit consistent with the cancelled payable", async () => {
    const owner = await createOwnerCtx(baseUrl, `Shortage Pay ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchaseId = await createPurchase(owner, supplierId, variantId, 10, 100);
    const itemId = await purchaseItemId(purchaseId);
    await receive(owner, purchaseId, itemId, 8, 100);
    await resolveOutstanding(owner, purchaseId, itemId, 2, "cancel", "closing");

    // Payable is now 800: paying 900 via supplier-payment is refused, 800 settles.
    const over = await postJson(
      baseUrl,
      owner,
      "/api/due-management/supplier-payment",
      { purchaseId, amount: 900, method: "cash" },
    );
    assert.equal(over.status, 400);

    const settle = await postJson(
      baseUrl,
      owner,
      "/api/due-management/supplier-payment",
      { purchaseId, amount: 800, method: "cash" },
    );
    assert.equal(settle.status, 201, JSON.stringify(settle.body));
    assert.equal(Number(settle.body?.data?.outstandingAfter), 0);
  });
});
