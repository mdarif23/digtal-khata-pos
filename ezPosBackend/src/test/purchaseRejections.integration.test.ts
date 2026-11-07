/**
 * Rejected-goods integration tests (Phase 4): the delivered/accepted/
 * rejected split, rejection categories and reasons, valuation exclusion,
 * the open rejection → resolution workflow (recorded only — no automatic
 * credits), and rollback — against a REAL PostgreSQL database.
 * Double-guarded like the other suites.
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

describe("purchase rejection integration", { skip: !runIntegration }, () => {
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

  async function dbRows(query: string, params: unknown[] = []) {
    const { rows } = await pg!.query(query, params as never[]);
    return rows;
  }

  it("splits delivered/accepted/rejected; rejected goods never reach inventory", async () => {
    const owner = await createOwnerCtx(baseUrl, `Reject Split ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    // Ordered 10, delivered 10, accepted 8, rejected 2 (damaged).
    const purchaseId = await createPurchase(owner, supplierId, variantId, 10, 100);
    const itemId = await purchaseItemId(purchaseId);

    const res = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: 8,
          rejectedQuantity: 2,
          rejectionCategory: "damaged",
          rejectionReason: "crushed cartons on arrival",
          unitCost: 100,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    // Only ACCEPTED goods in stock and batches.
    const stock = await dbRows(
      "SELECT quantity FROM inventory_stock WHERE business_id = $1 AND variant_id = $2",
      [owner.businessId, variantId],
    );
    assert.equal(Number(stock[0].quantity), 8);
    const batches = await dbRows(
      "SELECT quantity_received, purchase_price FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    );
    assert.equal(batches.length, 1);
    assert.equal(Number(batches[0].quantity_received), 8);

    // Line split: ordered preserved, delivered = accepted + rejected.
    const line = (await dbRows(
      `SELECT quantity, received_quantity, delivered_quantity, rejected_quantity
       FROM purchase_items WHERE id = $1`,
      [itemId],
    ))[0] as Record<string, string>;
    assert.equal(Number(line.quantity), 10);
    assert.equal(Number(line.received_quantity), 8);
    assert.equal(Number(line.delivered_quantity), 10);
    assert.equal(Number(line.rejected_quantity), 2);

    // Audit record carries the rejection details.
    const record = (await dbRows(
      `SELECT accepted_quantity, rejected_quantity, rejection_category, rejection_reason
       FROM purchase_receiving_records WHERE purchase_item_id = $1`,
      [itemId],
    ))[0] as Record<string, unknown>;
    assert.equal(Number(record.accepted_quantity), 8);
    assert.equal(Number(record.rejected_quantity), 2);
    assert.equal(record.rejection_category, "damaged");
    assert.equal(record.rejection_reason, "crushed cartons on arrival");

    // An OPEN rejection discrepancy awaits resolution.
    const discrepancy = (await dbRows(
      `SELECT type, quantity, category, status, resolution, receiving_record_id
       FROM purchase_discrepancies WHERE purchase_item_id = $1`,
      [itemId],
    ))[0] as Record<string, unknown>;
    assert.equal(discrepancy.type, "rejection");
    assert.equal(Number(discrepancy.quantity), 2);
    assert.equal(discrepancy.category, "damaged");
    assert.equal(discrepancy.status, "open");
    assert.equal(discrepancy.resolution, null);
    assert.ok(discrepancy.receiving_record_id, "linked to the receiving record");

    // The payable is untouched: rejected goods are not payable.
    const header = (await dbRows(
      "SELECT due_amount FROM purchases WHERE id = $1",
      [purchaseId],
    ))[0] as Record<string, string>;
    assert.equal(Number(header.due_amount), 1000);
    assert.equal(res.body?.data?.status, "partially_received");
  });

  it("supports reject-only deliveries (everything refused)", async () => {
    const owner = await createOwnerCtx(baseUrl, `Reject All ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchaseId = await createPurchase(owner, supplierId, variantId, 10, 100);
    const itemId = await purchaseItemId(purchaseId);

    const res = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: 0,
          rejectedQuantity: 10,
          rejectionCategory: "expired",
          rejectionReason: "three months past expiry",
          unitCost: 100,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const stock = await dbRows(
      "SELECT quantity FROM inventory_stock WHERE business_id = $1 AND variant_id = $2",
      [owner.businessId, variantId],
    );
    assert.equal(Number(stock[0].quantity), 0);
    const batches = await dbRows(
      "SELECT id FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    );
    assert.equal(batches.length, 0);
    const movements = await dbRows(
      `SELECT id FROM inventory_movements WHERE reference_id = $1 AND movement_type = 'purchase'`,
      [purchaseId],
    );
    assert.equal(movements.length, 0);

    const line = (await dbRows(
      "SELECT received_quantity, delivered_quantity, rejected_quantity FROM purchase_items WHERE id = $1",
      [itemId],
    ))[0] as Record<string, string>;
    assert.equal(Number(line.received_quantity), 0);
    assert.equal(Number(line.delivered_quantity), 10);
    assert.equal(Number(line.rejected_quantity), 10);
  });

  it("requires category and reason for rejected goods", async () => {
    const owner = await createOwnerCtx(baseUrl, `Reject Valid ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchaseId = await createPurchase(owner, supplierId, variantId, 5, 100);
    const itemId = await purchaseItemId(purchaseId);

    const noCategory = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: 4,
          rejectedQuantity: 1,
          rejectionReason: "broken",
          unitCost: 100,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(noCategory.status, 400);
    assert.match(String(noCategory.body?.message), /Invalid Purchase Data/);

    const noReason = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: 4,
          rejectedQuantity: 1,
          rejectionCategory: "incorrect",
          unitCost: 100,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(noReason.status, 400);

    // Nothing written by either attempt.
    const batches = await dbRows(
      "SELECT id FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    );
    assert.equal(batches.length, 0);
  });

  it("resolves rejections as supplier_credit or replacement — recorded, never auto-credited", async () => {
    const owner = await createOwnerCtx(baseUrl, `Reject Resolve ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchaseId = await createPurchase(owner, supplierId, variantId, 10, 100);
    const itemId = await purchaseItemId(purchaseId);
    await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: 8,
          rejectedQuantity: 2,
          rejectionCategory: "incorrect",
          rejectionReason: "wrong variant shipped",
          unitCost: 100,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    const discrepancy = (await dbRows(
      "SELECT id FROM purchase_discrepancies WHERE purchase_item_id = $1 AND type = 'rejection'",
      [itemId],
    ))[0] as { id: number };

    // Resolve as supplier_credit — a RECORD only.
    const credit = await postJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}/discrepancies/${discrepancy.id}/resolve`,
      { resolution: "supplier_credit", reason: "supplier agreed to credit" },
    );
    assert.equal(credit.status, 200, JSON.stringify(credit.body));
    assert.equal(credit.body?.data?.resolution, "supplier_credit");
    assert.equal(credit.body?.data?.status, "resolved");

    // No money moved: due unchanged, no ledger rows.
    const header = (await dbRows(
      "SELECT due_amount FROM purchases WHERE id = $1",
      [purchaseId],
    ))[0] as Record<string, string>;
    assert.equal(Number(header.due_amount), 1000);
    const ledger = await dbRows(
      "SELECT id FROM supplier_ledger WHERE business_id = $1 AND supplier_id = $2",
      [owner.businessId, supplierId],
    );
    assert.equal(ledger.length, 0);

    // Replacement scenario on a second rejection: the replacement arrives
    // as a later receive and clears the outstanding.
    const res2 = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: 2,
          unitCost: 100,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(res2.status, 201);
    assert.equal(res2.body?.data?.status, "received");

    // Double-resolve is refused.
    const again = await postJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}/discrepancies/${discrepancy.id}/resolve`,
      { resolution: "replacement" },
    );
    assert.equal(again.status, 409);
  });

  it("serves the discrepancy audit trail for the purchase", async () => {
    const owner = await createOwnerCtx(baseUrl, `Reject Trail ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchaseId = await createPurchase(owner, supplierId, variantId, 6, 100);
    const itemId = await purchaseItemId(purchaseId);
    await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: 5,
          rejectedQuantity: 1,
          rejectionCategory: "other",
          rejectionReason: "packaging breach",
          unitCost: 100,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });

    const trail = (await getJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}/discrepancies`,
    )).body as any;
    assert.equal(trail.data.receivingRecords.length, 1);
    assert.equal(Number(trail.data.receivingRecords[0].rejectedQuantity), 1);
    assert.equal(trail.data.receivingRecords[0].rejectionCategory, "other");
    assert.equal(trail.data.discrepancies.length, 1);
    assert.equal(trail.data.discrepancies[0].type, "rejection");
    assert.equal(trail.data.discrepancies[0].status, "open");

    // Foreign purchase id is scoped out.
    const foreign = await getJson(
      baseUrl,
      owner,
      "/api/purchases/999999/discrepancies",
    );
    assert.equal(foreign.status, 404);
  });

  it("rolls the whole receive back when a rejection line makes the payload invalid", async () => {
    const owner = await createOwnerCtx(baseUrl, `Reject Rollback ${Date.now()}`);
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

    // Line 1 is a valid rejection; line 2 breaks the batch-sum rule.
    const bad = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId: lineIds[0],
          trackingType: "none",
          receiveNow: 4,
          rejectedQuantity: 1,
          rejectionCategory: "damaged",
          rejectionReason: "damaged in transit",
          unitCost: 100,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
        },
        {
          itemId: lineIds[1],
          trackingType: "batch",
          receiveNow: 5,
          unitCost: 100,
          sellingPrice: 150,
          batches: [{ batchNumber: "B1", quantity: 2 }],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(bad.status, 400);

    // One transaction: no records, no discrepancies, no stock, no splits.
    const records = await dbRows(
      "SELECT id FROM purchase_receiving_records WHERE purchase_id = $1",
      [purchaseId],
    );
    assert.equal(records.length, 0);
    const discrepancies = await dbRows(
      "SELECT id FROM purchase_discrepancies WHERE purchase_id = $1",
      [purchaseId],
    );
    assert.equal(discrepancies.length, 0);
    const stock = await dbRows(
      "SELECT quantity FROM inventory_stock WHERE business_id = $1 AND variant_id = $2",
      [owner.businessId, variantId],
    );
    assert.equal(Number(stock[0].quantity), 0);
    const lines = await dbRows(
      "SELECT delivered_quantity, rejected_quantity FROM purchase_items WHERE purchase_id = $1",
      [purchaseId],
    );
    assert.deepEqual(
      lines.map((l) => [Number(l.delivered_quantity), Number(l.rejected_quantity)]),
      [
        [0, 0],
        [0, 0],
      ],
    );
  });

  /* ------------------------------------------------------------------
   * Phase 7 (payment & accounting): the rejected-goods dispute workflow —
   * accepted-only payable, recorded resolution, cancellation nets the
   * invoice, ledger and payment limits stay consistent.
   * ------------------------------------------------------------------ */

  it("runs the full dispute workflow: reject → resolve → cancel → payable and ledger stay consistent", async () => {
    const owner = await createOwnerCtx(baseUrl, `Reject Dispute ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    // Ordered 10, delivered 10: accepted 8, rejected 2. Invoice total 1000.
    const purchaseId = await createPurchase(owner, supplierId, variantId, 10, 100);
    const itemId = await purchaseItemId(purchaseId);
    const received = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: 8,
          rejectedQuantity: 2,
          rejectionCategory: "damaged",
          rejectionReason: "water damage in transit",
          unitCost: 100,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(received.status, 201, JSON.stringify(received.body));

    // 1. Record the dispute resolution (supplier_credit) — no money moves.
    const discrepancy = (await dbRows(
      "SELECT id FROM purchase_discrepancies WHERE purchase_item_id = $1 AND type = 'rejection'",
      [itemId],
    ))[0] as { id: number };
    const resolved = await postJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}/discrepancies/${discrepancy.id}/resolve`,
      { resolution: "supplier_credit", reason: "supplier accepted the claim" },
    );
    assert.equal(resolved.status, 200);
    const headerAfterResolve = (await dbRows(
      "SELECT due_amount FROM purchases WHERE id = $1",
      [purchaseId],
    ))[0] as Record<string, string>;
    assert.equal(Number(headerAfterResolve.due_amount), 1000); // untouched

    // 2. Cancel the outstanding 2 — the invoice nets to 800.
    const cancelled = await postJson(
      baseUrl,
      owner,
      `/api/purchases/${purchaseId}/outstanding-resolution`,
      {
        items: [
          { purchaseItemId: itemId, quantity: 2, resolution: "cancel", reason: "settled via supplier credit" },
        ],
      },
    );
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(Number(cancelled.body?.data?.dueAmount), 800);

    // 3. Ledger shows the cancellation credit; the rejection itself never
    //    produced a credit row.
    const ledger = await dbRows(
      `SELECT transaction_type, credit FROM supplier_ledger
       WHERE business_id = $1 AND supplier_id = $2 ORDER BY id`,
      [owner.businessId, supplierId],
    );
    assert.deepEqual(
      ledger.map((row) => [row.transaction_type, Number(row.credit)]),
      [["PURCHASE_CANCELLATION", 200]],
    );

    // 4. Valuation covers ONLY the accepted 8 (landed per unit 0 here).
    const batches = await dbRows(
      "SELECT quantity_received FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    );
    assert.equal(batches.length, 1);
    assert.equal(Number(batches[0].quantity_received), 8);

    // 5. Payment limit follows the netted payable: 900 refused, 800 settles.
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

  it("pays only for accepted goods in a receive that also rejects (single submission)", async () => {
    const owner = await createOwnerCtx(baseUrl, `Reject Pay ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchaseId = await createPurchase(owner, supplierId, variantId, 10, 100);
    const itemId = await purchaseItemId(purchaseId);

    // Accept 8, reject 2, and try to pay 900 (rejected goods are not
    // payable) — refused; 800 (accepted value) is accepted in-session.
    const over = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: 8,
          rejectedQuantity: 2,
          rejectionCategory: "incorrect",
          rejectionReason: "wrong variant shipped",
          unitCost: 100,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 900,
      paymentMethod: "cash",
    });
    assert.equal(over.status, 400);
    assert.match(String(over.body?.message), /Payment cannot be greater/);

    const ok = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: 8,
          rejectedQuantity: 2,
          rejectionCategory: "incorrect",
          rejectionReason: "wrong variant shipped",
          unitCost: 100,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 800,
      paymentMethod: "cash",
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(Number(ok.body?.data?.paidAmount), 800);
    assert.equal(Number(ok.body?.data?.dueAmount), 200); // invoice net of nothing yet — total 1000
  });
});

