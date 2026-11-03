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
});
