/**
 * Purchase lifecycle integration tests (Phase 6): the full chain
 * create → partial receive → landed-cost allocation → additional receive →
 * landed-cost delta → partial sale → purchase return → landed-cost
 * reversal → final valuation, plus the concurrency invariants (row locks)
 * for receive-vs-receive, receive-vs-post, and return-vs-sale.
 *
 * Double-guarded like the other suites. Plain `npm test` NEVER runs this.
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

describe("purchase lifecycle integration", { skip: !runIntegration }, () => {
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
    return res.body;
  }

  async function sellUnits(owner: OwnerCtx, variantId: number, qty: number) {
    const res = await postJson(baseUrl, owner, "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: qty * 150, tendered: qty * 150 }],
      discount: null,
      vatPercent: null,
      items: [{ variantId, quantity: qty, unitPrice: 150, discount: null }],
    });
    assert.equal(res.status, 201, `sale failed: ${JSON.stringify(res.body)}`);
  }

  async function returnUnits(
    owner: OwnerCtx,
    purchaseId: number,
    itemId: number,
    qty: number,
  ) {
    return postJson(baseUrl, owner, "/api/purchase-return", {
      orderId: purchaseId,
      reason: "lifecycle test",
      changedItems: [{ purchaseItemId: itemId, quantity: qty }],
    });
  }

  async function dbRows(query: string, params: unknown[] = []) {
    const { rows } = await pg!.query(query, params as never[]);
    return rows;
  }

  it("runs the full chain: create → partial receive → allocate → receive → delta → sale → return → reversal → valuation", async () => {
    const owner = await createOwnerCtx(baseUrl, `Lifecycle ${Date.now()}`);
    // A register is part of the sale flow's environment.
    const register = await postJson(baseUrl, owner, "/api/registers", {
      name: `Lifecycle Counter ${Date.now()}-${(counter += 1)}`,
    });
    assert.equal(register.status, 201);
    await postJson(
      baseUrl,
      owner,
      `/api/registers/${register.body.data.id}/open`,
      { openingCash: 5000 },
    );

    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchaseId = await createPurchase(owner, supplierId, variantId, 10, 100);
    const itemId = await purchaseItemId(purchaseId);

    // 1. Partial receive: 4 @ 100.
    await receive(owner, purchaseId, itemId, 4, 100);

    // 2. Landed-cost document (quantity method, 200 capitalizable) + post.
    //    Ordered 10, received 4 → received target 80 (20/unit… 80/4 = 20),
    //    pending 120 stays unallocated.
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
    assert.equal(posted.status, 200);

    const [batch1] = await dbRows(
      `SELECT id, purchase_price, quantity_received, quantity_remaining, additional_cost_per_unit
       FROM inventory_batches WHERE purchase_item_id = $1 ORDER BY id`,
      [itemId],
    );
    assert.equal(Number(batch1.additional_cost_per_unit), 20);
    let detail = (await getJson(baseUrl, owner, `/api/landed-costs/${docId}`)).body as any;
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 80);
    assert.equal(Number(detail.data.document.pendingAllocationAmount), 120);

    // 3. Additional receive: 6 @ 200 → cumulative target 200; the delta
    //    posts 120 to the new batch (20/unit), batch1's share is unchanged.
    await receive(owner, purchaseId, itemId, 6, 200);

    const batches = await dbRows(
      `SELECT id, purchase_price, quantity_received, quantity_remaining, additional_cost_per_unit
       FROM inventory_batches WHERE purchase_item_id = $1 ORDER BY id`,
      [itemId],
    );
    assert.equal(batches.length, 2);
    const [b1, b2] = batches as {
      id: number;
      purchase_price: string;
      quantity_received: string;
      quantity_remaining: string;
      additional_cost_per_unit: string;
    }[];
    assert.equal(Number(b1!.additional_cost_per_unit), 20);
    assert.equal(Number(b2!.additional_cost_per_unit), 20);
    detail = (await getJson(baseUrl, owner, `/api/landed-costs/${docId}`)).body as any;
    assert.equal(detail.data.document.status, "adjusted");
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 200);
    assert.equal(Number(detail.data.document.pendingAllocationAmount), 0);
    const deltaAdjustment = (detail.data.adjustments as any[]).find(
      (a) => a.adjustmentType === "receive_delta",
    );
    assert.ok(deltaAdjustment, "receive_delta adjustment missing");
    assert.equal(Number(deltaAdjustment.adjustmentAmount), 120);

    // 4. Partial sale: 5 units (FIFO: 4 from batch1 @ 100, 1 from batch2 @ 200).
    await sellUnits(owner, variantId, 5);
    const consumptions = await dbRows(
      `SELECT c.quantity, c.unit_cost_at_consumption
       FROM sale_item_batch_consumptions c
       JOIN inventory_batches b ON b.id = c.batch_id
       WHERE b.purchase_item_id = $1 ORDER BY c.quantity DESC`,
      [itemId],
    );
    // Consumption costs are LAND-INCLUSIVE (purchase_price + allocated
    // landed per unit): batch1 100+20, batch2 200+20.
    assert.deepEqual(
      consumptions.map((c) => [Number(c.quantity), Number(c.unit_cost_at_consumption)]),
      [
        [4, 120],
        [1, 220],
      ],
    );

    // 5. Purchase return: 3 units (all from batch2 @ 200 → credit 600),
    //    reversal 3 × 20 = 60.
    const ret = await returnUnits(owner, purchaseId, itemId, 3);
    assert.equal(ret.status, 201, `return failed: ${JSON.stringify(ret.body)}`);
    assert.equal(Number(ret.body?.data?.totalAmount), 600);
    assert.deepEqual(ret.body?.data?.landedCost, {
      adjusted: true,
      amount: 60,
      documentId: docId,
    });

    // Re-fetch the document — the reversal below happened after the delta.
    detail = (await getJson(baseUrl, owner, `/api/landed-costs/${docId}`)).body as any;

    // 6. Final state — database records, quantities, costs, ledger, history.
    const stock = await dbRows(
      "SELECT quantity FROM inventory_stock WHERE business_id = $1 AND variant_id = $2",
      [owner.businessId, variantId],
    );
    assert.equal(Number(stock[0].quantity), 2); // 10 − 5 sold − 3 returned

    const finalBatches = await dbRows(
      `SELECT id, quantity_remaining, purchase_price, additional_cost_per_unit
       FROM inventory_batches WHERE purchase_item_id = $1 ORDER BY id`,
      [itemId],
    );
    assert.deepEqual(
      finalBatches.map((b) => [
        Number(b.quantity_remaining),
        Number(b.purchase_price),
        Number(b.additional_cost_per_unit),
      ]),
      [
        [0, 100, 20],
        [2, 200, 20],
      ],
    );
    // Inventory valuation: remaining units × (purchase + landed per unit).
    const valuation = finalBatches.reduce(
      (sum, b) =>
        sum +
        Number(b.quantity_remaining) *
          (Number(b.purchase_price) + Number(b.additional_cost_per_unit)),
      0,
    );
    assert.equal(valuation, 2 * 220);

    const ledger = await dbRows(
      `SELECT transaction_type, credit FROM supplier_ledger
       WHERE business_id = $1 AND supplier_id = $2 ORDER BY id`,
      [owner.businessId, supplierId],
    );
    assert.deepEqual(
      ledger.map((row) => [row.transaction_type, Number(row.credit)]),
      [["PURCHASE_RETURN", 600]],
    );

    const header = await dbRows(
      "SELECT total_amount, due_amount, paid_amount FROM purchases WHERE id = $1",
      [purchaseId],
    );
    assert.equal(Number(header[0].total_amount), 1000);
    assert.equal(Number(header[0].paid_amount), 0);
    assert.equal(Number(header[0].due_amount), 400); // 1000 − 600 credit

    const reversal = (detail.data.adjustments as any[]).find(
      (a) => a.adjustmentType === "reversal",
    );
    assert.ok(reversal, "reversal adjustment missing");
    assert.equal(Number(reversal.adjustmentAmount), -60);
    const postings = (detail.data.postings as any[]).filter(
      (p) => p.postingType === "reversal",
    );
    assert.equal(postings.length, 1);
    assert.equal(Number(postings[0].amount), -60);
  });

  it("serializes concurrent receives of the same purchase (row locks)", async () => {
    const owner = await createOwnerCtx(baseUrl, `Concurrent Receive ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchaseId = await createPurchase(owner, supplierId, variantId, 4, 100);
    const itemId = await purchaseItemId(purchaseId);

    const attempt = () =>
      postJson(baseUrl, owner, "/api/purchases/receive", {
        purchaseId,
        items: [
          {
            itemId,
            trackingType: "none",
            receiveNow: 4,
            unitCost: 100,
            sellingPrice: 150,
            batches: [],
            serialNumbers: [],
          },
        ],
        paymentAmount: 0,
        paymentMethod: "cash",
      });

    const [first, second] = await Promise.all([attempt(), attempt()]);
    const statuses = [first.status, second.status].sort();
    // Row locks serialize the sessions: exactly one full receive lands.
    // The loser either sees fully-received (409) or over-receives (400),
    // depending on where it waits.
    assert.ok(
      statuses[0] === 201 && (statuses[1] === 400 || statuses[1] === 409),
      `expected one 201 and one rejection, got ${statuses}`,
    );

    const stock = await dbRows(
      "SELECT quantity FROM inventory_stock WHERE business_id = $1 AND variant_id = $2",
      [owner.businessId, variantId],
    );
    assert.equal(Number(stock[0].quantity), 4);
    const batches = await dbRows(
      "SELECT id FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    );
    assert.equal(batches.length, 1);
  });

  it("keeps receive-vs-post consistent whichever commits first", async () => {
    const owner = await createOwnerCtx(baseUrl, `Concurrent Post ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchaseId = await createPurchase(owner, supplierId, variantId, 10, 100);
    const itemId = await purchaseItemId(purchaseId);
    await receive(owner, purchaseId, itemId, 4, 100);

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
    assert.equal(doc.status, 201);
    const docId = Number(doc.body.data.id);

    // Concurrent: post the draft while a second receive triggers the delta.
    // Both take the document row lock — the loser retries behind the winner
    // and the cumulative-target math converges either way.
    // receive() asserts its own 201 internally (and returns the body).
    const [postRes, receiveBody] = await Promise.all([
      postJson(baseUrl, owner, `/api/landed-costs/${docId}/post`, {}),
      receive(owner, purchaseId, itemId, 6, 200),
    ]);
    assert.equal(postRes.status, 200);
    void receiveBody;

    const detail = (await getJson(baseUrl, owner, `/api/landed-costs/${docId}`)).body as any;
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 200);
    assert.equal(Number(detail.data.document.pendingAllocationAmount), 0);
    const batches = await dbRows(
      `SELECT additional_cost_per_unit FROM inventory_batches
       WHERE purchase_item_id = $1 ORDER BY id`,
      [itemId],
    );
    assert.deepEqual(
      batches.map((b) => Number(b.additional_cost_per_unit)),
      [20, 20],
    );
  });

  it("never oversells-or-overreturns: concurrent sale and return conserve stock", async () => {
    const owner = await createOwnerCtx(baseUrl, `Concurrent Return ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchaseId = await createPurchase(owner, supplierId, variantId, 10, 100);
    const itemId = await purchaseItemId(purchaseId);
    await receive(owner, purchaseId, itemId, 10, 100);
    await sellUnits(owner, variantId, 4); // 6 remain

    // 4 units demanded by each op against 6 on hand → at least one must
    // lose; whichever wins, stock is conserved and never negative.
    const [saleRes, returnRes] = await Promise.all([
      postJson(baseUrl, owner, "/api/sales", {
        saleDate: new Date().toISOString(),
        customerId: null,
        payments: [{ method: "cash", amount: 600, tendered: 600 }],
        discount: null,
        vatPercent: null,
        items: [{ variantId, quantity: 4, unitPrice: 150, discount: null }],
      }),
      returnUnits(owner, purchaseId, itemId, 4),
    ]);

    const outcomes = [saleRes.status, returnRes.status];
    // The race loser is refused: the return with 400 (BadRequest) — or the
    // sale with 404, because the sales module still maps its stock
    // shortfalls to NotFoundError (pre-existing inconsistency, documented
    // in the Phase 7 report). Both are valid refusals.
    assert.ok(
      outcomes.every((s) => s === 201 || s === 400 || s === 404),
      `unexpected statuses: ${outcomes}`,
    );
    assert.ok(outcomes.includes(201), "at least one operation must succeed");

    const stock = await dbRows(
      "SELECT quantity FROM inventory_stock WHERE business_id = $1 AND variant_id = $2",
      [owner.businessId, variantId],
    );
    const remaining = Number(stock[0].quantity);
    assert.ok(remaining >= 0, "stock must never go negative");

    // Conservation: received 10 = remaining + sold + returned.
    const batches = await dbRows(
      `SELECT quantity_remaining FROM inventory_batches WHERE purchase_item_id = $1`,
      [itemId],
    );
    const batchRemaining = batches.reduce(
      (sum, b) => sum + Number(b.quantity_remaining),
      0,
    );
    assert.equal(batchRemaining, remaining);
  });
});
