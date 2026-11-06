/**
 * Landed Cost Management — Phase 2 integration: context + preview endpoints
 * over the real purchase → receive → batches flow. Double-guarded like the
 * other suites (INTEGRATION_TESTS=1 + ezpos_test only).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";
import {
  authHeaders,
  createOwnerCtx,
  postJson,
  getJson,
  type OwnerCtx,
} from "./helpers/fixtures.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

const stamp = Date.now();

describe("landed cost integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let owner: OwnerCtx;
  let other: OwnerCtx;
  let purchaseId = 0;
  let smallItemId = 0;
  let mediumItemId = 0;
  let smallVariantId = 0;
  let mediumVariantId = 0;
  const SMALL_QTY = 10;
  const MEDIUM_QTY = 30;

  async function api(
    ctx: OwnerCtx,
    method: "GET" | "POST" | "PATCH",
    path: string,
    payload?: unknown,
  ) {
    if (method === "GET") return getJson(baseUrl, ctx, path);
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: authHeaders(ctx),
      body: JSON.stringify(payload ?? {}),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  before(async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const db = await client.query("SELECT current_database() AS db");
    if (db.rows[0]?.db !== "ezpos_test") {
      await client.end();
      throw new Error("SAFETY ABORT: not ezpos_test");
    }
    await client.end();
    await ensureRbacSeed();

    const app = buildApp();
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

    owner = await createOwnerCtx(baseUrl, `Landed Cost Biz ${stamp}`);
    other = await createOwnerCtx(baseUrl, `Landed Cost Other ${stamp}`, {
      noLocation: true,
    });

    const unit = await api(owner, "POST", "/api/product/unit", {
      unitName: `Piece ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = unit.body.data.value;

    // Variant types: Size (Small/Medium)
    const sizeType = await api(owner, "POST", "/api/product/variant-type", {
      variantTypeName: `Size ${stamp}`,
    });
    const sizeTypeId = sizeType.body.data?.id ?? sizeType.body.id;
    const sizeOptions = await api(owner, "POST", "/api/product/variant-option", {
      variantTypeId: sizeTypeId,
      variantOptionName: ["Small", "Medium"],
    });
    const optionIds = (sizeOptions.body.data ?? sizeOptions.body).map(
      (o: { id: number }) => o.id,
    ) as number[];

    const variant = (idx: number, sku: string, weight: number) => ({
      sku,
      barcode: null,
      sellingPrice: 150,
      alertQuantity: 1,
      isDefault: idx === 0,
      status: "active",
      imageUrl: null,
      imageFile: null,
      batchNumber: `LC-${sku}`,
      purchasePrice: 100,
      quantity: 1,
      expiryDate: null,
      weight,
      weightUnit: "kg",
      options: [
        {
          typeId: sizeTypeId,
          typeName: "Size",
          optionId: optionIds[idx],
          value: idx === 0 ? "Small" : "Medium",
        },
      ],
    });

    const product = await api(owner, "POST", "/api/product", {
      name: `Football ${stamp}`,
      categoryId: null,
      brandId: null,
      unitId,
      description: "",
      productType: "physical",
      hasVariants: true,
      trackingType: "none",
      supplierId: null,
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "opening",
      shippingWeightKg: 5, // product-level default (unused here; variants set)
      variants: [
        variant(0, `LC-S-${stamp}`, 2),
        variant(1, `LC-M-${stamp}`, 4),
      ],
    });
    assert.equal(product.status, 201, JSON.stringify(product.body));

    const list = await api(owner, "GET", "/api/products");
    const row = (list.body as any[]).find((p) => p.name === `Football ${stamp}`);
    assert.ok(row);
    const smallId = row.variants.find((v: any) => v.sku === `LC-S-${stamp}`).id;
    const mediumId = row.variants.find((v: any) => v.sku === `LC-M-${stamp}`).id;
    smallVariantId = smallId;
    mediumVariantId = mediumId;

    // Register for the POS sale flows used by the lifecycle tests.
    const register = await api(owner, "POST", "/api/registers", {
      name: `LC Counter ${stamp}`,
    });
    assert.equal(register.status, 201, JSON.stringify(register.body));
    const opened = await api(
      owner,
      "POST",
      `/api/registers/${register.body.data.id}/open`,
      { openingCash: 5000 },
    );
    assert.equal(opened.status, 201, JSON.stringify(opened.body));

    // Purchase: 10 Small + 30 Medium @ 100, no header charges.
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      notes: "landed cost test",
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId: smallId, quantity: SMALL_QTY, purchasePrice: 100, discount: 0, tax: 0 },
        { variantId: mediumId, quantity: MEDIUM_QTY, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.body));

    // Resolve item ids via the items endpoint.
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemRows = (items.body as any[]).filter(
      (i) => i.variantId === smallId || i.variantId === mediumId,
    );
    // POST /api/purchases returns only the PO number — resolve the id via
    // the items endpoint (repo convention).
    purchaseId = itemRows[0].purchaseId;
    smallItemId = itemRows.find((i) => i.variantId === smallId).id;
    mediumItemId = itemRows.find((i) => i.variantId === mediumId).id;

    // Full receive in one event (AUTO batches).
    const receive = await api(owner, "POST", "/api/purchases/receive", {
      purchaseId,
      items: [
        { itemId: smallItemId, trackingType: "none", receiveNow: SMALL_QTY, unitCost: 100, sellingPrice: 150, batches: [], serialNumbers: [] },
        { itemId: mediumItemId, trackingType: "none", receiveNow: MEDIUM_QTY, unitCost: 100, sellingPrice: 150, batches: [], serialNumbers: [] },
      ],
      paymentAmount: 4000,
      paymentMethod: "cash",
    });
    assert.equal(receive.status, 201, JSON.stringify(receive.body));
  });

  after(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  it("context: received lines with batches, variant names, weights", async () => {
    const res = await api(owner, "GET", `/api/purchases/${purchaseId}/landed-cost`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { data } = res.body as { data: any };
    assert.equal(data.lines.length, 2);
    const small = data.lines.find((l: any) => l.purchaseItemId === smallItemId);
    assert.equal(small.receivedQuantity, SMALL_QTY);
    assert.equal(small.variantWeight, 2);
    assert.ok(small.variantName.includes("Small"), small.variantName);
    assert.equal(small.batches.length, 1);
    assert.equal(small.batches[0].quantityReceived, SMALL_QTY);
  });

  it("quantity preview allocates 400 over 10/30 units and reconciles", async () => {
    const res = await api(
      owner,
      "POST",
      `/api/purchases/${purchaseId}/landed-cost/preview`,
      {
        method: "quantity",
        expenses: [
          { expenseType: "shipping", amount: 400, isCapitalizable: true },
        ],
      },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { data } = res.body as { data: any };
    assert.equal(data.totalCapitalizableAmount, 400);
    const small = data.allocation.lines.find(
      (l: any) => l.purchaseItemId === smallItemId,
    );
    const medium = data.allocation.lines.find(
      (l: any) => l.purchaseItemId === mediumItemId,
    );
    // 10/40 → 100; 30/40 → 300
    assert.equal(small.batches[0].allocatedAmount, 100);
    assert.equal(medium.batches[0].allocatedAmount, 300);
    assert.equal(small.batches[0].allocatedPerUnit, 10);
    assert.equal(medium.batches[0].allocatedPerUnit, 10);
    assert.equal(data.allocation.allocatedTotal, 400);
  });

  it("weight preview uses variant weights (2kg/4kg) normalized", async () => {
    const res = await api(
      owner,
      "POST",
      `/api/purchases/${purchaseId}/landed-cost/preview`,
      {
        method: "weight",
        expenses: [
          { expenseType: "customs", amount: 600, taxAmount: 0 },
        ],
      },
    );
    assert.equal(res.status, 200);
    const { data } = res.body as { data: any };
    const small = data.allocation.lines.find(
      (l: any) => l.purchaseItemId === smallItemId,
    );
    const medium = data.allocation.lines.find(
      (l: any) => l.purchaseItemId === mediumItemId,
    );
    // total weight 10×2 + 30×4 = 140 → 60 / 540? no: 20 vs 120 kg → 85.7143 / 514.2857
    assert.equal(small.lineAllocatedAmount, 85.7143);
    assert.equal(medium.lineAllocatedAmount, 514.2857);
    assert.equal(data.allocation.allocatedTotal, 600);
  });

  it("manual preview requires an exact split across every line", async () => {
    const mismatch = await api(
      owner,
      "POST",
      `/api/purchases/${purchaseId}/landed-cost/preview`,
      {
        method: "manual",
        expenses: [{ expenseType: "other", amount: 400 }],
        manualAllocations: [{ purchaseItemId: smallItemId, amount: 400 }],
      },
    );
    assert.equal(mismatch.status, 400);
    assert.ok(
      (mismatch.body.issues ?? []).some((i: any) => i.code === "incomplete_manual_allocation"),
      JSON.stringify(mismatch.body),
    );

    const exact = await api(
      owner,
      "POST",
      `/api/purchases/${purchaseId}/landed-cost/preview`,
      {
        method: "manual",
        expenses: [{ expenseType: "other", amount: 400 }],
        manualAllocations: [
          { purchaseItemId: smallItemId, amount: 100 },
          { purchaseItemId: mediumItemId, amount: 300 },
        ],
      },
    );
    assert.equal(exact.status, 200);
    const { data } = exact.body as { data: any };
    assert.equal(data.allocation.allocatedTotal, 400);
  });

  it("non-capitalizable expenses stay out of the allocation base", async () => {
    const res = await api(
      owner,
      "POST",
      `/api/purchases/${purchaseId}/landed-cost/preview`,
      {
        method: "quantity",
        expenses: [
          { expenseType: "shipping", amount: 400, isCapitalizable: true },
          { expenseType: "handling", amount: 60, isCapitalizable: false },
        ],
      },
    );
    assert.equal(res.status, 200);
    const { data } = res.body as { data: any };
    assert.equal(data.totalExpenseAmount, 460);
    assert.equal(data.totalCapitalizableAmount, 400);
    assert.equal(data.totalNonCapitalizableAmount, 60);
    assert.equal(data.allocation.allocatedTotal, 400);
  });

  it("rejects zero/negative expenses and unreceived purchases", async () => {
    const bad = await api(
      owner,
      "POST",
      `/api/purchases/${purchaseId}/landed-cost/preview`,
      { method: "quantity", expenses: [{ expenseType: "shipping", amount: -5 }] },
    );
    assert.equal(bad.status, 400);

    // Create a purchase but never receive it.
    const list = await api(owner, "GET", "/api/products");
    const row = (list.body as any[]).find((p) => p.name === `Football ${stamp}`);
    const variantId = row.variants[0].id;
    const fresh = await api(owner, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [{ variantId, quantity: 5, purchasePrice: 100, discount: 0, tax: 0 }],
    });
    assert.equal(fresh.status, 201);
    // find its id via items
    const items = await api(owner, "GET", "/api/purchases/items");
    const freshItem = (items.body as any[])
      .filter((i) => i.variantId === variantId)
      .sort((a, b) => b.id - a.id)[0];
    const unreceived = await api(
      owner,
      "GET",
      `/api/purchases/${freshItem.purchaseId}/landed-cost`,
    );
    assert.equal(unreceived.status, 400);
    assert.ok(
      (unreceived.body.issues ?? []).some((i: any) => i.code === "not_received"),
    );
  });

  it("enforces tenancy: another business cannot see the purchase", async () => {
    const res = await api(other, "GET", `/api/purchases/${purchaseId}/landed-cost`);
    assert.equal(res.status, 400);
    assert.ok(
      (res.body.issues ?? []).some((i: any) => i.code === "purchase_not_found"),
    );
  });

  // ---------- Phase 7: security (Part J) ----------

  it("rejects cross-business access to landed-cost documents", async () => {
    // Create + post a document as the owner.
    const pid = await createPurchaseOrdered(mediumVariantId, 20);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[])
      .filter((i) => i.purchaseId === pid && i.variantId === mediumVariantId)
      .sort((a, b) => b.id - a.id)[0].id;
    await receivePurchase(pid, itemId, 20);
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [{ expenseType: "shipping", amount: 100, isCapitalizable: true }],
    });
    assert.equal(doc.status, 201);
    const docId = doc.body.data.id as number;

    // Another business cannot read, edit, or post the document.
    const foreignGet = await api(other, "GET", `/api/landed-costs/${docId}`);
    assert.equal(foreignGet.status, 404);
    const foreignPatch = await api(other, "PATCH", `/api/landed-costs/${docId}`, {
      method: "quantity",
      expenses: [{ expenseType: "shipping", amount: 1 }],
    });
    assert.equal(foreignPatch.status, 404);
    const foreignPost = await api(other, "POST", `/api/landed-costs/${docId}/post`, {});
    assert.equal(foreignPost.status, 404);
    const foreignCreate = await api(
      other,
      "POST",
      `/api/purchases/${pid}/landed-cost`,
      { method: "quantity", expenses: [{ expenseType: "shipping", amount: 1 }] },
    );
    assert.equal(foreignCreate.status, 400);

    // The owner's document is untouched.
    const mine = await api(owner, "GET", `/api/landed-costs/${docId}`);
    assert.equal(mine.status, 200);
    assert.equal(
      ((mine.body as { data: any }).data.document.status),
      "draft",
    );
  });

  it("serializes concurrent posts — exactly one wins (Part J)", async () => {
    const pid = await createPurchaseOrdered(mediumVariantId, 20);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[])
      .filter((i) => i.purchaseId === pid && i.variantId === mediumVariantId)
      .sort((a, b) => b.id - a.id)[0].id;
    await receivePurchase(pid, itemId, 20);
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [{ expenseType: "insurance", amount: 200, isCapitalizable: true }],
    });
    assert.equal(doc.status, 201);
    const docId = doc.body.data.id as number;

    const [first, second] = await Promise.all([
      api(owner, "POST", `/api/landed-costs/${docId}/post`, {}),
      api(owner, "POST", `/api/landed-costs/${docId}/post`, {}),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);

    // Exactly one allocation set, no duplication.
    const detail = await api(owner, "GET", `/api/landed-costs/${docId}`);
    const docData = (detail.body as { data: any }).data;
    assert.equal(docData.document.status, "posted");
    assert.equal(docData.allocations.length, 1);
    assert.equal(Number(docData.allocations[0].allocatedAmount), 200);
    assert.equal(Number(docData.document.totalAllocatedAmount), 200);
  });

  // ---------- Phase 3: lifecycle, deltas, splits, reversals ----------

  async function createPurchaseOrdered(
    variantId: number,
    orderedQty: number,
  ): Promise<number> {
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId, quantity: orderedQty, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201);
    const items = await api(owner, "GET", "/api/purchases/items");
    const rows = (items.body as any[]).filter((i) => i.variantId === variantId);
    const mine = rows.sort((a, b) => b.id - a.id)[0];
    return mine.purchaseId;
  }

  async function receivePurchase(
    pid: number,
    itemId: number,
    qty: number,
  ) {
    const res = await api(owner, "POST", "/api/purchases/receive", {
      purchaseId: pid,
      items: [
        { itemId, trackingType: "none", receiveNow: qty, unitCost: 100, sellingPrice: 150, batches: [], serialNumbers: [] },
      ],
      paymentAmount: qty * 100,
      paymentMethod: "cash",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  async function sellUnits(variantId: number, qty: number): Promise<number> {
    const res = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: qty * 150, tendered: qty * 150 }],
      discount: null,
      vatPercent: null,
      items: [{ variantId, quantity: qty, unitPrice: 150, discount: null }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.sale.id as number;
  }

  async function dbRows(query: string, params: unknown[] = []) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const res = await client.query(query, params as never[]);
    await client.end();
    return res.rows;
  }

  it("partial receive → post → second receive posts the delta (Part F)", async () => {
    const pid = await createPurchaseOrdered(smallVariantId, 20);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[])
      .filter((i) => i.purchaseId === pid && i.variantId === smallVariantId)
      .sort((a, b) => b.id - a.id)[0].id;

    await receivePurchase(pid, itemId, 10);

    const created = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [{ expenseType: "shipping", amount: 200, isCapitalizable: true }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const docId = created.body.data.id as number;

    // One document per purchase.
    const duplicate = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [{ expenseType: "shipping", amount: 1 }],
    });
    assert.equal(duplicate.status, 409);

    // Draft edit works.
    const edited = await api(owner, "PATCH", `/api/landed-costs/${docId}`, {
      method: "quantity",
      expenses: [{ expenseType: "shipping", amount: 200, isCapitalizable: true }],
    });
    assert.equal(edited.status, 200);

    // Post: ordered 20, received 10 → half capitalizable, half pending.
    const posted = await api(owner, "POST", `/api/landed-costs/${docId}/post`, {});
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    const detail = await api(owner, "GET", `/api/landed-costs/${docId}`);
    const docData = (detail.body as { data: any }).data;
    assert.equal(docData.document.status, "posted");
    assert.equal(Number(docData.document.totalAllocatedAmount), 100);
    assert.equal(Number(docData.document.pendingAllocationAmount), 100);
    assert.equal(docData.allocations.length, 1);
    assert.equal(Number(docData.allocations[0].allocatedAmount), 100);
    const batchId = docData.allocations[0].inventoryBatchId as number;
    const batchRow = await dbRows(
      "SELECT additional_cost_per_unit FROM inventory_batches WHERE id = $1",
      [batchId],
    );
    assert.equal(Number(batchRow[0].additional_cost_per_unit), 10);

    // Inventory valuation now includes the landed cost: 10 remaining ×
    // (100 original + 10 landed) = 1100 (Phase 6).
    const stockReport = await api(
      owner,
      "GET",
      "/api/reports/inventory/stock?startDate=2020-01-01&endDate=2030-12-31&limit=200",
    );
    assert.equal(stockReport.status, 200);
    const stockRows = ((stockReport.body as { data: { data: any[] } }).data
      .data) as any[];
    // The stock report aggregates per variant. Small-variant batches at
    // this point: opening (1 × 100) + the before() purchase (10 × 100) +
    // this test's landed batch (10 × 110) = 2200.
    const variantStock = stockRows.find(
      (r) => r.variantId === smallVariantId && r.currentStock > 0,
    );
    assert.ok(variantStock);
    assert.equal(Number(variantStock.stockValue), 2200);

    // Posted documents are locked.
    const editAfterPost = await api(owner, "PATCH", `/api/landed-costs/${docId}`, {
      method: "quantity",
      expenses: [{ expenseType: "shipping", amount: 1 }],
    });
    assert.equal(editAfterPost.status, 409);

    // Second receive triggers the delta in the receive transaction.
    await receivePurchase(pid, itemId, 10);
    const detail2 = await api(owner, "GET", `/api/landed-costs/${docId}`);
    const docData2 = (detail2.body as { data: any }).data;
    assert.equal(docData2.document.status, "adjusted");
    assert.equal(Number(docData2.document.totalAllocatedAmount), 200);
    assert.equal(Number(docData2.document.pendingAllocationAmount), 0);
    // Two allocations now: batch1 100 (untouched) + batch2 100 (the delta).
    assert.equal(docData2.allocations.length, 2);
    const batch2Row = docData2.allocations.find(
      (a: any) => a.inventoryBatchId !== batchId,
    );
    assert.equal(Number(batch2Row.allocatedAmount), 100);
    const batch2Cost = await dbRows(
      "SELECT additional_cost_per_unit FROM inventory_batches WHERE id = $1",
      [batch2Row.inventoryBatchId],
    );
    assert.equal(Number(batch2Cost[0].additional_cost_per_unit), 10);
    const adjustments = docData2.adjustments as any[];
    const delta = adjustments.find((a) => a.adjustmentType === "receive_delta");
    assert.ok(delta, "receive_delta adjustment recorded");
    assert.equal(Number(delta.adjustmentAmount), 100);
    assert.equal(Number(delta.inventoryAmount), 100);
    assert.equal(Number(delta.cogsAmount), 0);
  });

  it("COGS includes landed cost and late postings split stock/COGS (Part F)", async () => {
    // Fresh product so FIFO premises hold regardless of other tests.
    const unit = await api(owner, "POST", "/api/product/unit", {
      unitName: `FIFO Piece ${stamp}`,
      abbreviation: "Fp",
    });
    const unitId = unit.body.data.value;
    const fifoProduct = await api(owner, "POST", "/api/product", {
      name: `FIFO Football ${stamp}`,
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
          sku: `LC-FIFO-${stamp}`,
          barcode: null,
          sellingPrice: 150,
          alertQuantity: 1,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `LC-FIFO-B-${stamp}`,
          purchasePrice: 100,
          quantity: 1,
          expiryDate: null,
          options: [],
        },
      ],
    });
    assert.equal(fifoProduct.status, 201, JSON.stringify(fifoProduct.body));
    const list = await api(owner, "GET", "/api/products");
    const fifoVariantId = ((list.body as any[]).find(
      (p) => p.name === `FIFO Football ${stamp}`,
    )).variants[0].id;

    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId: fifoVariantId, quantity: 20, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201);
    const items = await api(owner, "GET", "/api/purchases/items");
    const pid = (items.body as any[])
      .filter((i) => i.variantId === fifoVariantId)
      .sort((a, b) => b.id - a.id)[0].purchaseId;
    const itemId = (items.body as any[])
      .filter((i) => i.purchaseId === pid && i.variantId === fifoVariantId)
      .sort((a, b) => b.id - a.id)[0].id;

    await receivePurchase(pid, itemId, 10);

    // FIFO drains the fresh variant's opening batch (1 unit), then takes 3
    // units from the purchase batch — 4 sold BEFORE any landed cost exists.
    const saleId = await sellUnits(fifoVariantId, 4);
    const soldRows = await dbRows(
      "SELECT cost_at_sale FROM sale_items WHERE sale_id = $1",
      [saleId],
    );
    // No landed cost yet: cost_at_sale = plain purchase cost 100.
    assert.equal(Number(soldRows[0].cost_at_sale), 100);

    const consumption = await dbRows(
      "SELECT batch_id, quantity, unit_cost_at_consumption FROM sale_item_batch_consumptions WHERE sale_id = $1 ORDER BY quantity DESC",
      [saleId],
    );
    assert.equal(consumption.length, 2);
    const purchaseBatchRow = consumption.find((r: any) => r.quantity === 3);
    assert.ok(purchaseBatchRow, "purchase batch consumption row present");
    const newBatchId = purchaseBatchRow.batch_id as number;
    assert.equal(Number(purchaseBatchRow.unit_cost_at_consumption), 100);

    // Late document: ৳200 over ordered 20 → per-unit 10; 4 sold units
    // split their landed cost into COGS, 6 remaining stay inventory.
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [{ expenseType: "shipping", amount: 200, isCapitalizable: true }],
    });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const docId = doc.body.data.id as number;
    const posted = await api(owner, "POST", `/api/landed-costs/${docId}/post`, {});
    assert.equal(posted.status, 200, JSON.stringify(posted.body));

    const detail = await api(owner, "GET", `/api/landed-costs/${docId}`);
    const docData = (detail.body as { data: any }).data;
    const split = (docData.adjustments as any[]).find(
      (a) => a.referenceType === "landed_cost_post",
    );
    assert.ok(split, "stock/COGS split recorded on late post");
    // 3 of the 10 received units were already sold: ৳30 to COGS, ৳70 stays.
    assert.equal(Number(split.inventoryAmount), 70);
    assert.equal(Number(split.cogsAmount), 30);

    // A new sale AFTER the landed cost posts consumes at effective cost.
    const saleId2 = await sellUnits(fifoVariantId, 2);
    const sold2 = await dbRows(
      "SELECT cost_at_sale FROM sale_items WHERE sale_id = $1",
      [saleId2],
    );
    assert.equal(Number(sold2[0].cost_at_sale), 110); // 100 + 10 landed
  });

  it("validates settlement references server-side (Part G)", async () => {
    const pid = await createPurchaseOrdered(smallVariantId, 20);
    const items = await api(owner, "GET", "/api/purchases/items");
    void items;

    // expense_payment without a reference → rejected.
    const noRef = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [
        { expenseType: "shipping", amount: 100, settlementType: "expense_payment" },
      ],
    });
    assert.equal(noRef.status, 400);

    // expense_payment with an unknown expense → rejected.
    const badRef = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [
        {
          expenseType: "shipping",
          amount: 100,
          settlementType: "expense_payment",
          settlementReferenceId: 999_999_999,
        },
      ],
    });
    assert.equal(badRef.status, 400);

    // supplier_payable without a vendor → rejected.
    const noVendor = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [
        { expenseType: "customs", amount: 100, settlementType: "supplier_payable" },
      ],
    });
    assert.equal(noVendor.status, 400);
  });

  it("records the accounting postings trail on post and delta (Part G)", async () => {
    // A recorded expense payment to settle against.
    const expense = await api(owner, "POST", "/api/expenses", {
      title: `Freight ${stamp} A`,
      expense_date: new Date().toISOString().slice(0, 10),
      amount: 300,
      category_id: null,
      payment_method: "Cash",
    });
    assert.equal(expense.status, 201, JSON.stringify(expense.body));
    // The expenses controller returns the expense object RAW (no envelope).
    const settledExpenseId = (expense.body.id ??
      expense.body.data?.id) as number;
    assert.ok(settledExpenseId, JSON.stringify(expense.body));

    const pid = await createPurchaseOrdered(smallVariantId, 20);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[])
      .filter((i) => i.purchaseId === pid && i.variantId === smallVariantId)
      .sort((a, b) => b.id - a.id)[0].id;
    await receivePurchase(pid, itemId, 10);

    // ৳300 settled from the recorded expense payment + ৳60 period expense
    // (non-capitalizable, paid cash).
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [
        {
          expenseType: "shipping",
          amount: 300,
          isCapitalizable: true,
          settlementType: "expense_payment",
          settlementReferenceId: settledExpenseId,
        },
        {
          expenseType: "handling",
          amount: 60,
          isCapitalizable: false,
          settlementType: "cash",
        },
      ],
    });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const docId = doc.body.data.id as number;
    const posted = await api(owner, "POST", `/api/landed-costs/${docId}/post`, {});
    assert.equal(posted.status, 200, JSON.stringify(posted.body));

    let detail = await api(owner, "GET", `/api/landed-costs/${docId}`);
    let docData = (detail.body as { data: any }).data;

    // Postings: one capitalization (150 = received half of 300) + one
    // period expense (60), with settlement references carried.
    const cap = docData.postings.filter((p: any) => p.postingType === "capitalization");
    const exp = docData.postings.filter((p: any) => p.postingType === "expense");
    assert.equal(cap.length, 1);
    assert.equal(Number(cap[0].amount), 150);
    assert.equal(cap[0].paymentSource, "expense_payment");
    assert.equal(cap[0].paymentReferenceType, "expense");
    assert.equal(Number(cap[0].paymentReferenceId), settledExpenseId);
    assert.equal(exp.length, 1);
    assert.equal(Number(exp[0].amount), 60);
    assert.equal(exp[0].paymentSource, "cash");
    // Trail reconciles: Σ capitalization == totalAllocated.
    assert.equal(
      cap.reduce((s: number, p: any) => s + Number(p.amount), 0),
      Number(docData.document.totalAllocatedAmount),
    );

    // Second receive → delta posts its own capitalization posting linked
    // to the receive_delta adjustment.
    await receivePurchase(pid, itemId, 10);
    detail = await api(owner, "GET", `/api/landed-costs/${docId}`);
    docData = (detail.body as { data: any }).data;
    const deltaCap = docData.postings.filter(
      (p: any) =>
        p.postingType === "capitalization" &&
        p.adjustmentId !== null &&
        p.adjustmentId !== cap[0].adjustmentId,
    );
    assert.equal(deltaCap.length, 1);
    assert.equal(Number(deltaCap[0].amount), 150);
    // Σ all capitalization postings now equal total allocated (300).
    assert.equal(
      docData.postings
        .filter((p: any) => p.postingType === "capitalization")
        .reduce((s: number, p: any) => s + Number(p.amount), 0),
      Number(docData.document.totalAllocatedAmount),
    );
  });

  it("purchase returns reverse the allocated landed cost traceably", async () => {
    const supplier = await api(owner, "POST", "/api/contacts/supplier", {
      supplierName: `LC Supplier ${stamp}`,
      phone: "+8801711000099",
      email: null,
      address: null,
    });
    assert.equal(supplier.status, 201, JSON.stringify(supplier.body));
    const supplierId = supplier.body.data.supplierId as number;
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId: smallVariantId, quantity: 20, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201);
    const items = await api(owner, "GET", "/api/purchases/items");
    const pid = (items.body as any[])
      .filter((i) => i.variantId === smallVariantId)
      .sort((a, b) => b.id - a.id)[0].purchaseId;
    const itemId = (items.body as any[])
      .filter((i) => i.purchaseId === pid && i.variantId === smallVariantId)
      .sort((a, b) => b.id - a.id)[0].id;

    await receivePurchase(pid, itemId, 20);
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [{ expenseType: "shipping", amount: 200, isCapitalizable: true }],
    });
    assert.equal(doc.status, 201);
    const docId = doc.body.data.id as number;
    assert.equal((await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status, 200);

    // Return 5 units → reversal 5 × 10 = 50.
    const ret = await api(owner, "POST", "/api/purchase-return", {
      orderId: pid,
      reason: "Landed cost reversal test",
      changedItems: [{ purchaseItemId: itemId, quantity: 5 }],
    });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));
    // The return response carries the authoritative reversal feedback.
    assert.deepEqual((ret.body as { data: { landedCost: unknown } }).data.landedCost, {
      adjusted: true,
      amount: 50,
      documentId: docId,
    });

    const detail = await api(owner, "GET", `/api/landed-costs/${docId}`);
    const docData = (detail.body as { data: any }).data;
    const reversal = (docData.adjustments as any[]).find(
      (a) => a.adjustmentType === "reversal",
    );
    assert.ok(reversal, "reversal recorded");
    assert.equal(Number(reversal.adjustmentAmount), -50);
    assert.equal(Number(reversal.inventoryAmount), -50);
    // Per-unit landed cost of remaining units is unchanged.
    const batchRow = await dbRows(
      "SELECT additional_cost_per_unit FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    );
    assert.equal(Number(batchRow[0].additional_cost_per_unit), 10);
  });

  /**
   * F2 regression: an item whose FIRST-EVER receive happens after the
   * landed-cost document was posted must still be allocated — the
   * receive-delta runs inside the receive transaction, and the context
   * must read through that same transaction to see the just-received line.
   */
  it("allocates to an item first received after posting (tx-scoped context)", async () => {
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId: smallVariantId, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 },
        { variantId: mediumVariantId, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.body));
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const mine = (items.body as any[]).filter((i) => i.purchaseId === pid);
    const smallItem = mine.find((i) => i.variantId === smallVariantId);
    const mediumItem = mine.find((i) => i.variantId === mediumVariantId);
    assert.ok(smallItem && mediumItem);

    // Receive ONLY the small line, then create + post the doc.
    await receivePurchase(pid, smallItem.id, 10);
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [{ expenseType: "shipping", amount: 200, isCapitalizable: true }],
    });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const docId = doc.body.data.id as number;
    assert.equal((await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status, 200);

    // Small line allocated (10/unit), medium still unreceived → pending.
    const docAfterPost = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal(Number(docAfterPost.data.document.pendingAllocationAmount), 100);
    const listAfterPost = (await api(owner, "GET", "/api/purchases")).body as any;
    const poAfterPost = listAfterPost.allPurchases.find((p: any) => p.id === pid);
    assert.equal(poAfterPost.landedCostStatus, "pending");

    // First-ever receive of the medium line — inside THIS receive
    // transaction the delta must see the new line and allocate to it.
    await receivePurchase(pid, mediumItem.id, 10);

    const docAfterDelta = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal(Number(docAfterDelta.data.document.pendingAllocationAmount), 0);
    assert.equal(docAfterDelta.data.document.status, "adjusted");
    const mediumBatch = await dbRows(
      `SELECT additional_cost_per_unit, quantity_received
       FROM inventory_batches WHERE purchase_item_id = $1`,
      [mediumItem.id],
    );
    assert.ok(mediumBatch.length > 0, "medium batch missing");
    assert.equal(Number(mediumBatch[0].additional_cost_per_unit), 10);

    // Fully allocated → list indicator flips.
    const listAfterDelta = (await api(owner, "GET", "/api/purchases")).body as any;
    const poAfterDelta = listAfterDelta.allPurchases.find((p: any) => p.id === pid);
    assert.equal(poAfterDelta.landedCostStatus, "allocated");
  });
});
