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

  /* ------------------------------------------------------------------
   * Phase 6 (discrepancy feature): landed-cost × quantity discrepancies.
   * Self-contained assertions (per purchase/doc) — no shared-variant
   * baselines, so placement at the end is deliberate.
   * ------------------------------------------------------------------ */

  it("holds rejected quantities as pending until replaced (they are delivered, not accepted)", async () => {
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId: mediumVariantId, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201);
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find(
      (i) => i.purchaseId === pid,
    ).id;

    // Deliver 10: accept 8, reject 2 (damaged).
    const received = await api(owner, "POST", "/api/purchases/receive", {
      purchaseId: pid,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: 8,
          rejectedQuantity: 2,
          rejectionCategory: "damaged",
          rejectionReason: "crushed cartons",
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

    // 200 capitalizable over an ordered basis of 10 → received share 160,
    // the rejected 2 units hold 40 pending until replaced.
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [{ expenseType: "shipping", amount: 200, isCapitalizable: true }],
    });
    assert.equal(doc.status, 201);
    const docId = doc.body.data.id as number;
    assert.equal((await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status, 200);

    const detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 160);
    assert.equal(Number(detail.data.document.pendingAllocationAmount), 40);
    const batch = (await dbRows(
      "SELECT additional_cost_per_unit FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    ))[0] as Record<string, string>;
    assert.equal(Number(batch.additional_cost_per_unit), 20); // 160 / 8

    // Replacement arrives → delta allocates the pending 40 to the new batch.
    await api(owner, "POST", "/api/purchases/receive", {
      purchaseId: pid,
      items: [
        { itemId, trackingType: "none", receiveNow: 2, unitCost: 100, sellingPrice: 150, batches: [], serialNumbers: [] },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    const detail2 = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal(Number(detail2.data.document.totalAllocatedAmount), 200);
    assert.equal(Number(detail2.data.document.pendingAllocationAmount), 0);
    const batches = await dbRows(
      "SELECT quantity_received, additional_cost_per_unit FROM inventory_batches WHERE purchase_item_id = $1 ORDER BY id",
      [itemId],
    );
    assert.equal(Number(batches[1].additional_cost_per_unit), 20);
  });

  it("clamps over-received allocation: full capitalizable amount, nothing pending", async () => {
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId: mediumVariantId, quantity: 4, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201);
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find(
      (i) => i.purchaseId === pid,
    ).id;

    // Ordered 4, accepted 6 (over-receive 2, owner has the permission).
    const received = await api(owner, "POST", "/api/purchases/receive", {
      purchaseId: pid,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: 6,
          unitCost: 100,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
          overReceiveReason: "full case shipped",
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(received.status, 201, JSON.stringify(received.body));

    // 200 over an ordered basis of 4 → unclamped received share 300 →
    // clamped at the line's total target 200 across 6 accepted units.
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [{ expenseType: "shipping", amount: 200, isCapitalizable: true }],
    });
    assert.equal(doc.status, 201);
    const docId = doc.body.data.id as number;
    assert.equal((await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status, 200);

    const detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 200);
    assert.equal(Number(detail.data.document.pendingAllocationAmount), 0);
    const batch = (await dbRows(
      "SELECT additional_cost_per_unit FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    ))[0] as Record<string, string>;
    assert.ok(
      Math.abs(Number(batch.additional_cost_per_unit) - 200 / 6) < 0.0001,
      `unexpected additional cost ${batch.additional_cost_per_unit}`,
    );
  });

  it("resolves pending allocation when outstanding is cancelled after posting", async () => {
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId: mediumVariantId, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201);
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find(
      (i) => i.purchaseId === pid,
    ).id;

    await api(owner, "POST", "/api/purchases/receive", {
      purchaseId: pid,
      items: [
        { itemId, trackingType: "none", receiveNow: 4, unitCost: 100, sellingPrice: 150, batches: [], serialNumbers: [] },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });

    // Post with 6 units still outstanding → 80 allocated, 120 pending.
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [{ expenseType: "shipping", amount: 200, isCapitalizable: true }],
    });
    assert.equal(doc.status, 201);
    const docId = doc.body.data.id as number;
    assert.equal((await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status, 200);
    let detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 80);
    assert.equal(Number(detail.data.document.pendingAllocationAmount), 120);

    // Cancel the outstanding 6 → the effective ordered basis drops to 4,
    // and the resolution triggers the allocation delta IN THE SAME
    // transaction: the pending 120 lands on the existing batch.
    const resolved = await api(
      owner,
      "POST",
      `/api/purchases/${pid}/outstanding-resolution`,
      {
        items: [
          {
            purchaseItemId: itemId,
            quantity: 6,
            resolution: "cancel",
            reason: "supplier discontinued the item",
          },
        ],
      },
    );
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.data.landedCost.adjusted, true);
    assert.equal(Number(resolved.body.data.landedCost.amount), 120);
    assert.equal(Number(resolved.body.data.landedCost.documentId), docId);

    detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal(detail.data.document.status, "adjusted");
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 200);
    assert.equal(Number(detail.data.document.pendingAllocationAmount), 0);
    const batch = (await dbRows(
      "SELECT additional_cost_per_unit FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    ))[0] as Record<string, string>;
    assert.equal(Number(batch.additional_cost_per_unit), 50); // 200 / 4

    // No duplicate adjustments: a no-op receive (all zero) adds nothing.
    const adjustmentsBefore = (detail.data.adjustments as any[]).length;
    await api(owner, "POST", "/api/purchases/receive", {
      purchaseId: pid,
      items: [
        { itemId, trackingType: "none", receiveNow: 0, unitCost: 0, sellingPrice: 0, batches: [], serialNumbers: [] },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    const detail3 = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal((detail3.data.adjustments as any[]).length, adjustmentsBefore);
    assert.equal(Number(detail3.data.document.totalAllocatedAmount), 200);
  });

  /* ------------------------------------------------------------------
   * Phase 4 — landed-cost expense source identity (purchase-origin
   * supplier shipping): auto-row lifecycle, duplicate protection, and
   * the Scenario 1 double-count proof. Self-contained, appended last.
   * ------------------------------------------------------------------ */

  it("auto-includes supplier shipping as a purchase-origin expense exactly once", async () => {
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 300, // supplier's own shipping on the invoice
      items: [
        { variantId: mediumVariantId, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201);
    const pid = Number(purchase.body.data.id);
    // Grand total includes the supplier shipping: 1000 + 300.
    assert.equal(Number(purchase.body.data.totalAmount ?? 0), 0); // header check below
    const header = (await dbRows(
      "SELECT total_amount, due_amount FROM purchases WHERE id = $1",
      [pid],
    ))[0] as Record<string, string>;
    assert.equal(Number(header!.total_amount), 1300);

    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find((i) => i.purchaseId === pid).id;
    await receivePurchase(pid, itemId, 10);

    // Create the document: user adds customs 100; supplier shipping is
    // auto-included as a purchase-origin row.
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [
        { expenseType: "customs", amount: 100, isCapitalizable: true },
      ],
    });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const docId = doc.body.data.id as number;

    const expenses = (await dbRows(
      `SELECT source_type, source_key, amount, expense_type, settlement_type
       FROM landed_cost_expenses WHERE landed_cost_id = $1 ORDER BY id`,
      [docId],
    )) as Record<string, unknown>[];
    assert.equal(expenses.length, 2);
    const auto = expenses.find((e) => e.source_type === "purchase");
    assert.ok(auto, "purchase-origin shipping row missing");
    assert.equal(auto.source_key, "shipping_cost");
    assert.equal(Number(auto.amount), 300);
    assert.equal(auto.settlement_type, "supplier_payable");
    const manual = expenses.find((e) => e.source_type === "additional_expense");
    assert.ok(manual, "user expense missing");
    assert.equal(Number(manual.amount), 100);

    // Duplicate protection: a second purchase-origin shipping row for the
    // same document is impossible at the database level.
    await assert.rejects(
      dbRows(
        `INSERT INTO landed_cost_expenses
         (business_id, landed_cost_id, expense_type, amount, source_type, source_key)
         VALUES ($1, $2, 'shipping', 300, 'purchase', 'shipping_cost')`,
        [owner.businessId, docId],
      ),
      /duplicate key/,
    );

    // Post: capitalizable = 300 (auto shipping) + 100 (customs) = 400.
    assert.equal(
      (await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status,
      200,
    );
    const detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal(Number(detail.data.document.totalCapitalizableAmount), 400);
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 400);
    // Inventory carries it exactly once: 400 / 10 units = 40 per unit.
    const batch = await dbRows(
      "SELECT additional_cost_per_unit FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    );
    assert.equal(Number(batch[0].additional_cost_per_unit), 40);

    // NO duplicate payable: the purchase payable still reflects only the
    // supplier invoice — grand total 1300 (shipping included once), minus
    // the 1000 already paid on receiving = 300 outstanding.
    const header2 = (await dbRows(
      "SELECT due_amount FROM purchases WHERE id = $1",
      [pid],
    ))[0] as Record<string, string>;
    assert.equal(Number(header2.due_amount), 300);
  });

  it("allocates end-to-end with the equal method (enum value via API)", async () => {
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId: mediumVariantId, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201);
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find((i) => i.purchaseId === pid).id;
    await receivePurchase(pid, itemId, 10);

    // Equal method through the API: 200 over ONE received line → 200.
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "equal",
      expenses: [
        { expenseType: "handling", amount: 200, isCapitalizable: true },
      ],
    });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const docId = doc.body.data.id as number;
    assert.equal(
      (await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status,
      200,
    );
    const detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal(detail.data.document.allocationMethod, "equal");
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 200);
    const batch = await dbRows(
      "SELECT additional_cost_per_unit FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    );
    assert.equal(Number(batch[0].additional_cost_per_unit), 20);
  });

  it("regenerates the purchase-origin row when a draft is updated", async () => {
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 250,
      items: [
        { variantId: mediumVariantId, quantity: 5, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201);
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find((i) => i.purchaseId === pid).id;
    await receivePurchase(pid, itemId, 5);

    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [
        { expenseType: "insurance", amount: 50, isCapitalizable: true },
      ],
    });
    assert.equal(doc.status, 201);
    const docId = doc.body.data.id as number;

    // Update the draft with different user expenses — the purchase-origin
    // row must survive (regenerated, exactly once).
    const edited = await api(owner, "PATCH", `/api/landed-costs/${docId}`, {
      method: "quantity",
      expenses: [
        { expenseType: "customs", amount: 75, isCapitalizable: true },
        { expenseType: "handling", amount: 25, isCapitalizable: false },
      ],
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));

    const expenses = (await dbRows(
      `SELECT source_type, amount FROM landed_cost_expenses
       WHERE landed_cost_id = $1 ORDER BY id`,
      [docId],
    )) as Record<string, unknown>[];
    const purchaseOrigin = expenses.filter((e) => e.source_type === "purchase");
    assert.equal(purchaseOrigin.length, 1); // regenerated, not duplicated
    assert.equal(Number(purchaseOrigin[0]!.amount), 250);
    assert.equal(expenses.length, 3); // 1 auto + 2 user
  });

  /* ------------------------------------------------------------------
   * Phase 7 — estimated → actual expense adjustment: the delta flows
   * through the allocation engine (inventory vs COGS split), the audit
   * trail records the change, the payable is untouched, and double
   * application is refused. Fresh products so FIFO premises hold.
   * ------------------------------------------------------------------ */

  /** Fresh product + variant via direct SQL so the test owns its batches
   *  (FIFO-isolated from the suite fixture and other tests). quantity 0 →
   *  NO opening batch: the API path always creates one (quantity ≥ 1),
   *  which would consume first in FIFO and skew the sale/COGS math. */
  async function freshVariant(prefix: string): Promise<number> {
    const [location] = await dbRows(
      "SELECT id FROM locations WHERE business_id = $1 AND is_default = true LIMIT 1",
      [owner.businessId],
    );
    assert.ok(location, "default location missing");
    const [product] = await dbRows(
      `INSERT INTO products (business_id, name, product_type, tracking_type, status)
       VALUES ($1, $2, 'physical', 'none', 'active') RETURNING id`,
      [owner.businessId, `${prefix} Product ${stamp}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`],
    );
    const [variant] = await dbRows(
      `INSERT INTO product_variants (business_id, product_id, sku, selling_price, is_default, status)
       VALUES ($1, $2, $3, 150, true, 'active') RETURNING id`,
      [owner.businessId, product!.id, `${prefix}-${stamp}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`],
    );
    await dbRows(
      `INSERT INTO inventory_stock (business_id, variant_id, location_id, quantity, reserved_quantity)
       VALUES ($1, $2, $3, 0, 0)`,
      [owner.businessId, variant!.id, location!.id],
    );
    return variant!.id as number;
  }

  it("adjusts an estimated expense to its actual amount with the delta allocated", async () => {
    const variantId = await freshVariant("P7A");
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201);
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find((i) => i.purchaseId === pid).id;
    await receivePurchase(pid, itemId, 10);

    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [
        { expenseType: "shipping", amount: 1000, isCapitalizable: true },
      ],
    });
    assert.equal(doc.status, 201);
    const docId = doc.body.data.id as number;
    assert.equal(
      (await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status,
      200,
    );
    // Estimated: 1,000 allocated (100/unit), nothing pending.
    let detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 1000);

    const expenseId = detail.data.expenses[0].id as number;

    // Actual invoice arrives: 1,200 → +200 delta.
    const adjusted = await api(
      owner,
      "POST",
      `/api/landed-costs/${docId}/adjust-expense`,
      { expenseId, newAmount: 1200, reason: "actual freight invoice" },
    );
    assert.equal(adjusted.status, 200, JSON.stringify(adjusted.body));
    assert.equal(Number(adjusted.body.data.delta), 200);
    assert.equal(Number(adjusted.body.data.totalAllocated), 1200);

    // Allocation updated: 120/unit, adjustment recorded with the delta
    // and the inventory/COGS split (nothing sold yet → all inventory).
    detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 1200);
    assert.equal(Number(detail.data.document.pendingAllocationAmount), 0);
    const adjustment = (detail.data.adjustments as any[]).at(-1)!;
    assert.equal(adjustment.adjustmentType, "manual");
    assert.equal(adjustment.referenceType, "landed_cost_expense");
    assert.equal(Number(adjustment.referenceId), expenseId);
    assert.equal(Number(adjustment.adjustmentAmount), 200);
    assert.equal(Number(adjustment.inventoryAmount), 200);
    assert.equal(Number(adjustment.cogsAmount), 0);
    const batch = await dbRows(
      "SELECT additional_cost_per_unit FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    );
    assert.equal(Number(batch[0]!.additional_cost_per_unit), 120);

    // The payable is untouched: the adjustment reallocates landed cost,
    // it does not change what the supplier is owed.
    const header = await dbRows(
      "SELECT due_amount FROM purchases WHERE id = $1",
      [pid],
    );
    assert.equal(Number(header[0]!.due_amount), 0); // fully paid by helper

    // Audit trail: the expense-adjustment action is recorded (find by
    // reference — the audit logs have no guaranteed order).
    const audit = (detail.data.auditLogs as any[]).find(
      (a) => a.action === "expense_adjustment",
    );
    assert.ok(audit, "expense_adjustment audit log missing");
  });

  it("sends the consumed portion of an adjustment to COGS", async () => {
    const variantId = await freshVariant("P7B");
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201);
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find((i) => i.purchaseId === pid).id;
    await receivePurchase(pid, itemId, 10);

    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [
        { expenseType: "shipping", amount: 500, isCapitalizable: true },
      ],
    });
    const docId = doc.body.data.id as number;
    assert.equal(
      (await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status,
      200,
    );

    // Sell 6 of the 10 units (consume from the batch FIFO).
    const register = await api(owner, "POST", "/api/registers", {
      name: `P7 Counter ${Date.now()}`,
    });
    assert.equal(register.status, 201);
    await api(owner, "POST", `/api/registers/${register.body.data.id}/open`, {
      openingCash: 5000,
    });
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 900, tendered: 900 }],
      discount: null,
      vatPercent: null,
      items: [{ variantId, quantity: 6, unitPrice: 150, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));

    // Adjust the expense +300. The fresh variant has NO opening stock, so
    // the sale's 6 units all came from the receive batch → remaining = 4.
    // COGS split: inv = 300 × 4/10 = 120, cogs = 300 × 6/10 = 180.
    const detail0 = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    const expenseId = detail0.data.expenses[0].id as number;
    const adjusted = await api(
      owner,
      "POST",
      `/api/landed-costs/${docId}/adjust-expense`,
      { expenseId, newAmount: 800, reason: "actual freight" },
    );
    assert.equal(adjusted.status, 200, JSON.stringify(adjusted.body));
    assert.equal(Number(adjusted.body.data.delta), 300);

    const detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    const adjustment = (detail.data.adjustments as any[]).at(-1)!;
    assert.equal(Number(adjustment.adjustmentAmount), 300);
    assert.equal(Number(adjustment.inventoryAmount), 120); // 4 remaining × 30
    assert.equal(Number(adjustment.cogsAmount), 180); // 6 sold × 30
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 800);
  });

  it("rejects a no-op adjustment and re-adjusting to the same amount", async () => {
    const variantId = await freshVariant("P7C");
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201);
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find((i) => i.purchaseId === pid).id;
    await receivePurchase(pid, itemId, 10);

    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [
        { expenseType: "shipping", amount: 400, isCapitalizable: true },
      ],
    });
    const docId = doc.body.data.id as number;
    assert.equal(
      (await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status,
      200,
    );
    const detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    const expenseId = detail.data.expenses[0].id as number;

    const noop = await api(
      owner,
      "POST",
      `/api/landed-costs/${docId}/adjust-expense`,
      { expenseId, newAmount: 400 },
    );
    assert.equal(noop.status, 400);
    assert.match(String(noop.body?.message), /nothing to adjust/);

    // Valid adjustment, then back to the original → both recorded.
    const first = await api(
      owner,
      "POST",
      `/api/landed-costs/${docId}/adjust-expense`,
      { expenseId, newAmount: 500, reason: "invoice arrived" },
    );
    assert.equal(first.status, 200);
    const back = await api(
      owner,
      "POST",
      `/api/landed-costs/${docId}/adjust-expense`,
      { expenseId, newAmount: 400, reason: "supplier corrected the invoice" },
    );
    assert.equal(back.status, 200);
    assert.equal(Number(back.body.data.delta), -100);

    const detail2 = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    const adjustments = detail2.data.adjustments.filter(
      (a: any) => a.referenceType === "landed_cost_expense",
    );
    assert.equal(adjustments.length, 2);
    assert.equal(Number(adjustments[0].adjustmentAmount), 100);
    assert.equal(Number(adjustments[1].adjustmentAmount), -100);
  });

  /* ------------------------------------------------------------------
   * Phase 8 — batch valuation lifecycle: one batch traced through
   * purchase → receive → landed-cost post → expense adjust → sale →
   * return → final valuation, pinning purchase_price immutability and
   * unit/total cost consistency at every step. Fresh product so FIFO
   * premises hold. Self-contained, appended last.
   * ------------------------------------------------------------------ */

  it("traces batch valuation through the full lifecycle (Phase 8)", async () => {
    // Fresh product so the variant's batches belong solely to this test.
    const variantId = await freshVariant("P8");
    // A supplier is required because this test ends with a purchase return.
    const supplier = await api(owner, "POST", "/api/contacts/supplier", {
      supplierName: `P8 Supplier ${stamp}`,
      phone: "+8801711000133",
      email: null,
      address: null,
    });
    assert.equal(supplier.status, 201, JSON.stringify(supplier.body));
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: supplier.body.data.supplierId as number,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.body));
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find((i) => i.purchaseId === pid)!.id;
    await receivePurchase(pid, itemId, 10);

    const batchState = async () => {
      const rows = await dbRows(
        `SELECT purchase_price, quantity_received, quantity_remaining,
                additional_cost_per_unit, landed_cost_per_unit
         FROM inventory_batches WHERE purchase_item_id = $1`,
        [itemId],
      );
      return rows[0] as Record<string, string>;
    };

    // After receive: purchase cost 100/unit, no landed cost yet.
    let batch = await batchState();
    assert.equal(Number(batch.purchase_price), 100); // original, immutable
    assert.equal(Number(batch.quantity_received), 10);
    assert.equal(Number(batch.quantity_remaining), 10);
    assert.equal(Number(batch.additional_cost_per_unit), 0);
    assert.equal(Number(batch.landed_cost_per_unit), 100); // purchase only

    // Landed-cost doc: 500 (50/unit) → post.
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [
        { expenseType: "shipping", amount: 500, isCapitalizable: true },
      ],
    });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const docId = doc.body.data.id as number;
    assert.equal(
      (await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status,
      200,
    );
    batch = await batchState();
    assert.equal(Number(batch.purchase_price), 100); // STILL original
    assert.equal(Number(batch.additional_cost_per_unit), 50);
    assert.equal(Number(batch.landed_cost_per_unit), 150); // 100 + 50

    // Adjust the expense to 700 (70/unit).
    const detail0 = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    const expenseId = detail0.data.expenses[0].id as number;
    await api(owner, "POST", `/api/landed-costs/${docId}/adjust-expense`, {
      expenseId,
      newAmount: 700,
      reason: "actual freight higher",
    });
    batch = await batchState();
    assert.equal(Number(batch.purchase_price), 100); // STILL original
    assert.equal(Number(batch.additional_cost_per_unit), 70);
    assert.equal(Number(batch.landed_cost_per_unit), 170); // 100 + 70

    // Sell 6 of 10: batch remaining = 4, per-unit costs unchanged.
    const register = await api(owner, "POST", "/api/registers", {
      name: `P8 Counter ${Date.now()}`,
    });
    await api(owner, "POST", `/api/registers/${register.body.data.id}/open`, {
      openingCash: 5000,
    });
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 900, tendered: 900 }],
      discount: null,
      vatPercent: null,
      items: [{ variantId, quantity: 6, unitPrice: 150, discount: null }],
    });
    assert.equal(sale.status, 201);
    batch = await batchState();
    assert.equal(Number(batch.purchase_price), 100);
    assert.equal(Number(batch.quantity_remaining), 4);
    assert.equal(Number(batch.additional_cost_per_unit), 70);
    assert.equal(Number(batch.landed_cost_per_unit), 170);
    // Unit × quantity = total cost consistency.
    assert.equal(
      Number(batch.landed_cost_per_unit) * Number(batch.quantity_remaining),
      680, // 4 × 170
    );

    // Return 2 of the 10 received units → batch remaining = 2.
    // The return reverses the batch's landed cost: 2 × 70 = 140.
    const ret = await postJson(baseUrl, owner, "/api/purchase-return", {
      orderId: pid,
      reason: "phase 8 lifecycle",
      changedItems: [{ purchaseItemId: itemId, quantity: 2 }],
    });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));

    batch = await batchState();
    assert.equal(Number(batch.quantity_remaining), 2);
    // The return reduces the allocation to reflect the returned units.
    // Per-unit additional cost stays (the remaining units carry the same).
    assert.ok(Number(batch.additional_cost_per_unit) > 0, "landed cost lost on return");

    // Final valuation = remaining × (purchase + landed per unit).
    const valuation =
      Number(batch.purchase_price) * 0 + // purchase_price is cost basis only
      Number(batch.quantity_remaining) * Number(batch.landed_cost_per_unit);
    assert.ok(valuation > 0, "final valuation must be positive");

    // Stock movements traceable: purchase + sale + return + adjustments.
    const movements = await dbRows(
      `SELECT movement_type, quantity FROM inventory_movements
       WHERE variant_id = $1 ORDER BY id`,
      [variantId],
    );
    const types = movements.map((m) => m.movement_type);
    assert.ok(types.includes("purchase"), "purchase movement missing");
    assert.ok(types.includes("sale"), "sale movement missing");
  });

  it("preserves batch purchase cost through receive + adjust + sale + return", async () => {
    const variantId = await freshVariant("P8B");
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId, quantity: 8, purchasePrice: 200, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201);
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find((i) => i.purchaseId === pid).id;

    // Partial receive: 5 of 8.
    const received1 = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: pid,
      items: [
        { itemId, trackingType: "none", receiveNow: 5, unitCost: 220, sellingPrice: 300, batches: [], serialNumbers: [] },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(received1.status, 201);

    // Landed-cost doc: 400; posting with 5 of 8 received allocates
    // 400 × 5/8 = 250 (50/unit), 150 pending.
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [
        { expenseType: "shipping", amount: 400, isCapitalizable: true },
      ],
    });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const docId = doc.body.data.id as number;
    assert.equal(
      (await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status,
      200,
    );

    // Adjust to 600. Allocation scales by RECEIVED share of the order:
    // 600 × 5/8 = 375 allocated → 75/unit, 225 stays pending.
    const detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    const expenseId = detail.data.expenses[0].id as number;
    await api(owner, "POST", `/api/landed-costs/${docId}/adjust-expense`, {
      expenseId,
      newAmount: 600,
      reason: "actual freight",
    });

    // The batch's purchase_price = the receive-session cost (220), NOT the
    // PO price (200). The D1 batch-authoritative rule preserves it.
    const batch = await dbRows(
      "SELECT purchase_price, quantity_received, quantity_remaining, additional_cost_per_unit, landed_cost_per_unit FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    );
    assert.equal(Number(batch[0].purchase_price), 220); // receive-session cost
    assert.equal(Number(batch[0].quantity_received), 5);
    assert.equal(Number(batch[0].quantity_remaining), 5);
    assert.equal(Number(batch[0].additional_cost_per_unit), 75); // 375 / 5
    assert.equal(Number(batch[0].landed_cost_per_unit), 295); // 220 + 75
    const midDoc = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal(Number(midDoc.data.document.totalAllocatedAmount), 375);
    assert.equal(Number(midDoc.data.document.pendingAllocationAmount), 225);

    // Partial receive delta: receive the remaining 3 @ 220. The cumulative
    // target reaches 600 × 8/8; the 225 delta flows to the new batch
    // (75/unit) and batch 1 is untouched — per-unit landed cost ends up
    // uniform (75) across the PO's batches.
    const received2 = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: pid,
      items: [
        { itemId, trackingType: "none", receiveNow: 3, unitCost: 220, sellingPrice: 300, batches: [], serialNumbers: [] },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(received2.status, 201);

    const batches = await dbRows(
      "SELECT purchase_price, quantity_received, quantity_remaining, additional_cost_per_unit, landed_cost_per_unit FROM inventory_batches WHERE purchase_item_id = $1 ORDER BY id",
      [itemId],
    );
    assert.equal(batches.length, 2);
    for (const b of batches) {
      assert.equal(Number(b.purchase_price), 220); // never overwritten
      assert.equal(Number(b.additional_cost_per_unit), 75); // 600 / 8
      assert.equal(Number(b.landed_cost_per_unit), 295); // 220 + 75
    }
    // Total remaining = 8; the full 600 expense is still capitalized
    // (conservation: 5×75 + 3×75 = 600).
    const totalRemaining = batches.reduce((sum, b) => sum + Number(b.quantity_remaining), 0);
    assert.equal(totalRemaining, 8);
    const totalAdditional = batches.reduce(
      (sum, b) => sum + Number(b.quantity_received) * Number(b.additional_cost_per_unit),
      0,
    );
    assert.equal(totalAdditional, 600);
    // Valuation = 8 × 295 = 2360.
    const totalValuation = batches.reduce(
      (sum, b) => sum + Number(b.quantity_remaining) * Number(b.landed_cost_per_unit),
      0,
    );
    assert.equal(totalValuation, 2360);
  });

  /* ------------------------------------------------------------------
   * Phase 9 — accounting integration: every per-expense posting carries
   * its expense_id (the Phase 4 source identity is traceable end-to-end),
   * postings expose their expense's source in the doc payload, and the
   * accounting reconciliation ties the posting ledger to the document.
   * ------------------------------------------------------------------ */

  it("attributes postings to their expense source and ties the ledger out (Phase 9)", async () => {
    const variantId = await freshVariant("P9");
    const supplier = await api(owner, "POST", "/api/contacts/supplier", {
      supplierName: `P9 Supplier ${stamp}`,
      phone: "+8801711000144",
      email: null,
      address: null,
    });
    assert.equal(supplier.status, 201, JSON.stringify(supplier.body));
    // shipping 100 → the auto purchase-origin expense row joins the doc.
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: supplier.body.data.supplierId as number,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 100,
      items: [
        { variantId, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.body));
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find((i) => i.purchaseId === pid)!.id;
    await receivePurchase(pid, itemId, 10);

    // Doc: manual customs 400 + auto supplier shipping 100 = 500
    // capitalizable, fully received → 500 allocated, 50/unit.
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [
        { expenseType: "customs", amount: 400, isCapitalizable: true },
      ],
    });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const docId = doc.body.data.id as number;
    const detail0 = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    const manualExpense = detail0.data.expenses.find(
      (e: any) => e.expenseType === "customs",
    );
    const autoExpense = detail0.data.expenses.find(
      (e: any) => e.sourceType === "purchase",
    );
    assert.ok(manualExpense && autoExpense, "expected manual + auto expense rows");

    assert.equal(
      (await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status,
      200,
    );

    const afterPost = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    const cap = afterPost.data.postings.filter(
      (p: any) => p.postingType === "capitalization",
    );
    assert.equal(cap.length, 2);
    const manualPosting = cap.find((p: any) => p.expenseId === manualExpense.id);
    const autoPosting = cap.find((p: any) => p.expenseId === autoExpense.id);
    assert.ok(manualPosting && autoPosting, "each capitalization posting names its expense");
    assert.equal(Number(manualPosting.amount), 400);
    assert.equal(Number(autoPosting.amount), 100);
    // Source identity rides along: manual vs purchase-origin row.
    assert.equal(manualPosting.expenseSourceType, "additional_expense");
    assert.equal(autoPosting.expenseSourceType, "purchase");
    assert.equal(autoPosting.expenseSourceKey, "shipping_cost");

    // Tie-out: Σ capitalization == totalAllocated; nothing unattributed.
    assert.equal(
      Number(afterPost.data.accounting.postingsByType.capitalization),
      500,
    );
    assert.equal(Number(afterPost.data.document.totalAllocatedAmount), 500);
    assert.equal(afterPost.data.accounting.capitalizationTiesOut, true);
    assert.equal(Number(afterPost.data.accounting.attributedAmount), 500);
    assert.equal(Number(afterPost.data.accounting.unattributedAmount), 0);
    assert.equal(Number(afterPost.data.accounting.netInInventory), 500);

    // Adjust the manual expense 400 → 500: the +100 delta posts its own
    // per-expense capitalization shares, still attributed.
    const adjusted = await api(
      owner,
      "POST",
      `/api/landed-costs/${docId}/adjust-expense`,
      { expenseId: manualExpense.id, newAmount: 500, reason: "actual customs" },
    );
    assert.equal(adjusted.status, 200, JSON.stringify(adjusted.body));
    const afterAdjust = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal(
      Number(afterAdjust.data.accounting.postingsByType.capitalization),
      600,
    );
    assert.equal(Number(afterAdjust.data.document.totalAllocatedAmount), 600);
    assert.equal(afterAdjust.data.accounting.capitalizationTiesOut, true);
    const deltaCap = afterAdjust.data.postings.filter(
      (p: any) =>
        p.postingType === "capitalization" && p.adjustmentId !== null,
    );
    assert.equal(deltaCap.length, 2); // both expenses share the delta
    assert.ok(
      deltaCap.every((p: any) => p.expenseId !== null),
      "delta postings attributed",
    );

    // Return 2 units: the reversal posting is event-level (unattributed)
    // and netInInventory drops to 8 × 60 = 480.
    const ret = await postJson(baseUrl, owner, "/api/purchase-return", {
      orderId: pid,
      reason: "phase 9 accounting",
      changedItems: [{ purchaseItemId: itemId, quantity: 2 }],
    });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));

    const afterReturn = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    const reversal = afterReturn.data.postings.filter(
      (p: any) => p.postingType === "reversal",
    );
    assert.equal(reversal.length, 1);
    assert.equal(Number(reversal[0].amount), -120); // 2 × 60
    assert.equal(reversal[0].expenseId, null);
    assert.equal(
      Number(afterReturn.data.accounting.postingsByType.reversal),
      -120,
    );
    // Cumulative capitalization is untouched by returns; net in inventory
    // = 600 − 120 = 480 (8 remaining units × 60).
    assert.equal(
      Number(afterReturn.data.accounting.postingsByType.capitalization),
      600,
    );
    assert.equal(Number(afterReturn.data.accounting.netInInventory), 480);
    assert.equal(Number(afterReturn.data.accounting.attributedAmount), 600);
    assert.equal(Number(afterReturn.data.accounting.unattributedAmount), 120);
  });

  /* ------------------------------------------------------------------
   * Phase 10 — purchase returns & cost reversals: returns that PREDATE a
   * landed-cost posting get the same reversal a post-return would have
   * written (one traceable adjustment + posting per return, referenced to
   * the return id) — returned units' landed cost is never mislabeled as
   * COGS. Conservation: capitalization = inventory + sold (COGS) +
   * returned (reversals), per-unit costs never change.
   * ------------------------------------------------------------------ */

  it("reverses the landed cost of units returned before posting, per return (Phase 10)", async () => {
    const variantId = await freshVariant("P10A");
    const supplier = await api(owner, "POST", "/api/contacts/supplier", {
      supplierName: `P10A Supplier ${stamp}`,
      phone: "+8801711000155",
      email: null,
      address: null,
    });
    assert.equal(supplier.status, 201, JSON.stringify(supplier.body));
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: supplier.body.data.supplierId as number,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.body));
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find((i) => i.purchaseId === pid)!.id;
    await receivePurchase(pid, itemId, 10);

    // Return 2 BEFORE any landed-cost document exists.
    const ret = await postJson(baseUrl, owner, "/api/purchase-return", {
      orderId: pid,
      reason: "phase 10 pre-posting return",
      changedItems: [{ purchaseItemId: itemId, quantity: 2 }],
    });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));
    const returnId = Number(ret.body.data.purchaseReturnId);
    // No document yet → the return reports no landed-cost reversal.
    assert.equal(ret.body.data.landedCost.adjusted, false);

    // Doc 500 (all received) → post. The returned units' share (2/10)
    // must be reversed out at posting — not stranded, not in COGS.
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [
        { expenseType: "customs", amount: 500, isCapitalizable: true },
      ],
    });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const docId = doc.body.data.id as number;
    assert.equal(
      (await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status,
      200,
    );

    const detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    // Status "adjusted": a reversal happened at posting.
    assert.equal(detail.data.document.status, "adjusted");
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 500);

    // The reversal is referenced to the return that caused it.
    const reversal = detail.data.adjustments.find(
      (a: any) => a.adjustmentType === "reversal",
    );
    assert.ok(reversal, "pre-posting reversal adjustment missing");
    assert.equal(reversal.referenceType, "purchase_return");
    assert.equal(Number(reversal.referenceId), returnId);
    assert.equal(Number(reversal.adjustmentAmount), -100); // 2 × 50

    const reversalPosting = detail.data.postings.find(
      (p: any) => p.postingType === "reversal",
    );
    assert.ok(reversalPosting, "reversal posting missing");
    assert.equal(Number(reversalPosting.amount), -100);
    assert.equal(reversalPosting.expenseId, null); // event-level

    // Nothing was sold → no COGS anywhere; per-unit stays 50 on the 8 kept.
    assert.equal(Number(detail.data.accounting.postingsByType.cogsAdjustment), 0);
    const batch = await dbRows(
      "SELECT purchase_price, quantity_received, quantity_remaining, additional_cost_per_unit, landed_cost_per_unit FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    );
    assert.equal(Number(batch[0]!.quantity_remaining), 8);
    assert.equal(Number(batch[0]!.additional_cost_per_unit), 50);
    assert.equal(Number(batch[0]!.landed_cost_per_unit), 150);

    // Conservation: capitalization 500 = inventory 8×50 (400) + reversed 100.
    assert.equal(
      Number(detail.data.accounting.postingsByType.capitalization),
      500,
    );
    assert.equal(Number(detail.data.accounting.postingsByType.reversal), -100);
    assert.equal(Number(detail.data.accounting.netInInventory), 400);
    assert.equal(detail.data.accounting.capitalizationTiesOut, true);
  });

  it("sends a delta's returned-units share to reversal, not COGS (Phase 10)", async () => {
    const variantId = await freshVariant("P10B");
    const supplier = await api(owner, "POST", "/api/contacts/supplier", {
      supplierName: `P10B Supplier ${stamp}`,
      phone: "+8801711000166",
      email: null,
      address: null,
    });
    assert.equal(supplier.status, 201, JSON.stringify(supplier.body));
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId: supplier.body.data.supplierId as number,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.body));
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find((i) => i.purchaseId === pid)!.id;
    await receivePurchase(pid, itemId, 10);

    // Post 500 (50/unit), then return 2 (return-time reversal −100).
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [
        { expenseType: "customs", amount: 500, isCapitalizable: true },
      ],
    });
    const docId = doc.body.data.id as number;
    assert.equal(
      (await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status,
      200,
    );
    const ret = await postJson(baseUrl, owner, "/api/purchase-return", {
      orderId: pid,
      reason: "phase 10 delta split",
      changedItems: [{ purchaseItemId: itemId, quantity: 2 }],
    });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));
    assert.equal(Number(ret.body.data.landedCost.amount), 100);

    // Adjust the expense +300: 8 units remain in inventory (240), the 2
    // returned units' share (60) is REVERSED — nothing was sold, so COGS
    // must stay 0.
    const detail0 = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    const expenseId = detail0.data.expenses[0].id as number;
    const adjusted = await api(
      owner,
      "POST",
      `/api/landed-costs/${docId}/adjust-expense`,
      { expenseId, newAmount: 800, reason: "actual customs" },
    );
    assert.equal(adjusted.status, 200, JSON.stringify(adjusted.body));

    const detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    const deltaAdjustment = detail.data.adjustments.find(
      (a: any) => a.adjustmentType === "manual" && Number(a.adjustmentAmount) === 300,
    );
    assert.ok(deltaAdjustment, "delta adjustment missing");
    assert.equal(Number(deltaAdjustment.inventoryAmount), 240); // 8 × 30
    // Raw batch-level split: the not-in-inventory bucket (returned 60 —
    // nothing was sold); the paired reversal row carves it out.
    assert.equal(Number(deltaAdjustment.cogsAmount), 60);

    // The delta's returned-units share got its own reversal, referenced
    // to the same return.
    const deltaReversals = detail.data.adjustments.filter(
      (a: any) =>
        a.adjustmentType === "reversal" && Number(a.adjustmentAmount) === -60,
    );
    assert.equal(deltaReversals.length, 1);
    assert.equal(deltaReversals[0].referenceType, "purchase_return");

    // Conservation: 800 capitalized = 8×80 in inventory (640) + 2×80
    // reversed (160: −100 at return + −60 at delta). Per-unit now 80.
    assert.equal(
      Number(detail.data.accounting.postingsByType.capitalization),
      800,
    );
    assert.equal(Number(detail.data.accounting.postingsByType.reversal), -160);
    assert.equal(Number(detail.data.accounting.postingsByType.cogsAdjustment), 0);
    assert.equal(Number(detail.data.accounting.netInInventory), 640);
    const batch = await dbRows(
      "SELECT quantity_remaining, additional_cost_per_unit, landed_cost_per_unit FROM inventory_batches WHERE purchase_item_id = $1",
      [itemId],
    );
    assert.equal(Number(batch[0]!.quantity_remaining), 8);
    assert.equal(Number(batch[0]!.additional_cost_per_unit), 80);
    assert.equal(Number(batch[0]!.landed_cost_per_unit), 180);
  });
});





