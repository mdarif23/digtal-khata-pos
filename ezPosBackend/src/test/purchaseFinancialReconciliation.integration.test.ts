/**
 * Purchase Financial Summary & Landed Cost Integration — Phase 12:
 * financial testing and reconciliation. Walks COMPLETE lifecycles and ties
 * every ledger out against every other:
 *
 *   invoice totals  = the authoritative financials formula
 *   supplier ledger = payables (due = grand total − paid − credits)
 *   postings        = the allocation (Σ capitalization == totalAllocated)
 *   conservation    = capitalization = netInInventory(batches)
 *                     + soldUnitsLanded + |reversal|
 *   classification  = the acquisition-cost view (discount reduces it,
 *                     expenses mirror the doc total)
 *
 * Double-guarded like the other suites (INTEGRATION_TESTS=1 + ezpos_test).
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

describe("purchase financial reconciliation", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let owner: OwnerCtx;

  async function api(
    ctx: OwnerCtx,
    method: "GET" | "POST",
    path: string,
    payload?: unknown,
  ) {
    const init: RequestInit = { method, headers: authHeaders(ctx) };
    if (payload !== undefined) {
      init.body = JSON.stringify(payload);
    }
    const res = await fetch(`${baseUrl}${path}`, init);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async function dbRows(query: string, params: unknown[] = []) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const res = await client.query(query, params as never[]);
    await client.end();
    return res.rows;
  }

  /** Fresh variant via direct SQL — quantity 0, NO opening batch, so the
   *  sale consumes exactly the receive batch (FIFO premises hold). */
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

  async function makeSupplier(prefix: string): Promise<number> {
    const supplier = await api(owner, "POST", "/api/contacts/supplier", {
      supplierName: `${prefix} Supplier ${stamp}`,
      phone: "+8801711000177",
      email: null,
      address: null,
    });
    assert.equal(supplier.status, 201, JSON.stringify(supplier.body));
    return supplier.body.data.supplierId as number;
  }

  async function receivePurchase(
    pid: number,
    itemId: number,
    qty: number,
    unitCost: number,
    paymentAmount: number,
  ) {
    const res = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: pid,
      items: [
        { itemId, trackingType: "none", receiveNow: qty, unitCost, sellingPrice: 150, batches: [], serialNumbers: [] },
      ],
      paymentAmount,
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

  async function returnUnits(
    pid: number,
    itemId: number,
    qty: number,
  ) {
    const ret = await postJson(baseUrl, owner, "/api/purchase-return", {
      orderId: pid,
      reason: "phase 12 reconciliation",
      changedItems: [{ purchaseItemId: itemId, quantity: qty }],
    });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));
    return ret.body.data;
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
    owner = await createOwnerCtx(baseUrl, `Recon Biz ${stamp}`);
  });

  after(() => {
    server?.close();
  });

  it("reconciles every ledger through the full lifecycle (Phase 12)", async () => {
    // ---- Invoice: % order discount + order tax + supplier shipping ----
    const variantA = await freshVariant("R1A");
    const variantB = await freshVariant("R1B");
    const supplierId = await makeSupplier("R1");
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId,
      purchaseDate: new Date().toISOString(),
      discount: 10,
      discountBasis: "percentage",
      tax: 95,
      shippingCost: 105,
      items: [
        { variantId: variantA, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 },
        { variantId: variantB, quantity: 5, purchasePrice: 200, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.body));
    const pid = Number(purchase.body.data.id);

    // Authoritative formula: 2000 − 10% (200) + 95 + 105 = 2000.
    const header0 = await api(owner, "GET", `/api/purchases/${pid}`);
    // The detail endpoint answers UNWRAPPED: { purchase, items }.
    assert.equal(Number(header0.body.purchase.subtotal), 2000);
    assert.equal(Number(header0.body.purchase.discount), 200);
    const grandTotal = Number(header0.body.purchase.totalAmount);
    assert.equal(grandTotal, 2000);
    assert.equal(Number(header0.body.purchase.dueAmount), 2000);

    const items = await api(owner, "GET", "/api/purchases/items");
    const itemA = (items.body as any[]).find(
      (i) => i.purchaseId === pid && i.variantId === variantA,
    );
    const itemB = (items.body as any[]).find(
      (i) => i.purchaseId === pid && i.variantId === variantB,
    );

    // ---- Receive everything, paying 2,000 across two sessions ----
    await receivePurchase(pid, itemA.id, 10, 100, 1000);
    await receivePurchase(pid, itemB.id, 5, 200, 1000);
    const afterReceive = await api(owner, "GET", `/api/purchases/${pid}`);
    assert.equal(Number(afterReceive.body.purchase.dueAmount), 0);
    assert.equal(afterReceive.body.purchase.paymentStatus, "paid");

    // ---- Landed cost (value method; equal line values → 50/50) ----
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "value",
      expenses: [
        { expenseType: "customs", amount: 400, isCapitalizable: true },
        { expenseType: "insurance", amount: 100, isCapitalizable: false },
      ],
    });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const docId = doc.body.data.id as number;
    const posted = await api(owner, "POST", `/api/landed-costs/${docId}/post`, {});
    assert.equal(posted.status, 200, JSON.stringify(posted.body));

    let detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    // Capitalizable = customs 400 + auto supplier shipping 105; insurance
    // is expensed. Fully received → fully allocated.
    assert.equal(Number(detail.data.document.totalCapitalizableAmount), 505);
    assert.equal(Number(detail.data.document.totalExpenseAmount), 605);
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 505);
    assert.equal(Number(detail.data.document.pendingAllocationAmount), 0);
    // Classification mirrors the doc (no order discount on this doc's
    // expenses — wait, the purchase HAS a 10% discount: the acquisition
    // VIEW reduces by it, the allocation does not).
    assert.equal(Number(detail.data.components.totals.capitalizable), 305);
    // Expensed bucket = non-capitalizable insurance 100 + the excluded
    // order tax 95 (the classification reports excluded amounts there).
    assert.equal(Number(detail.data.components.totals.expensed), 195);

    // Value method, equal line values: 252.50 per line.
    const batches1 = await dbRows(
      `SELECT b.purchase_item_id, b.quantity_received, b.quantity_remaining,
              b.additional_cost_per_unit, b.landed_cost_per_unit
       FROM inventory_batches b WHERE b.purchase_item_id IN ($1, $2) ORDER BY b.id`,
      [itemA.id, itemB.id],
    );
    const batchA = batches1.find((b) => b.purchase_item_id === itemA.id)!;
    const batchB = batches1.find((b) => b.purchase_item_id === itemB.id)!;
    assert.equal(Number(batchA.additional_cost_per_unit), 25.25);
    assert.equal(Number(batchB.additional_cost_per_unit), 50.5);

    // ---- Sell 6 of variant A: COGS carries the landed-inclusive cost ----
    const saleId = await sellUnits(variantA, 6);
    const consumption = await dbRows(
      "SELECT quantity, unit_cost_at_consumption FROM sale_item_batch_consumptions WHERE sale_id = $1",
      [saleId],
    );
    const soldCost = consumption.reduce(
      (sum, c) => sum + Number(c.quantity) * Number(c.unit_cost_at_consumption),
      0,
    );
    assert.equal(soldCost, 751.5); // 6 × 125.25

    // ---- Adjust customs 400 → 500 (+100) ----
    const expenseId = detail.data.expenses.find(
      (e: any) => e.expenseType === "customs",
    ).id as number;
    const adjusted = await api(
      owner,
      "POST",
      `/api/landed-costs/${docId}/adjust-expense`,
      { expenseId, newAmount: 500, reason: "actual customs" },
    );
    assert.equal(adjusted.status, 200, JSON.stringify(adjusted.body));

    detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal(Number(detail.data.document.totalCapitalizableAmount), 605);
    assert.equal(Number(detail.data.document.totalAllocatedAmount), 605);
    // Delta split: line A 4 remaining × 5 = 20 inventory, 6 sold × 5 = 30
    // COGS; line B 5 × 10 = 50 inventory.
    const deltaAdjustment = detail.data.adjustments.find(
      (a: any) => a.adjustmentType === "manual" && Number(a.adjustmentAmount) === 100,
    );
    assert.ok(deltaAdjustment, "delta adjustment missing");
    assert.equal(Number(deltaAdjustment.inventoryAmount), 70);
    assert.equal(Number(deltaAdjustment.cogsAmount), 30);

    // ---- Return 2 of line B: goods credit + landed reversal ----
    const returnData = await returnUnits(pid, itemB.id, 2);
    assert.equal(Number(returnData.totalAmount), 400); // 2 × 200 batch cost
    assert.equal(Number(returnData.landedCost.amount), 121); // 2 × 60.50

    // ---- FINAL RECONCILIATION ----
    detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    const accounting = detail.data.accounting;

    // Postings tie to the document.
    assert.equal(accounting.capitalizationTiesOut, true);
    assert.equal(Number(accounting.postingsByType.capitalization), 605);
    assert.equal(Number(accounting.postingsByType.reversal), -121);

    // Batches: A 4 × 30.25, B 3 × 60.50.
    const batches2 = await dbRows(
      `SELECT b.purchase_item_id, b.quantity_remaining, b.additional_cost_per_unit, b.landed_cost_per_unit
       FROM inventory_batches b WHERE b.purchase_item_id IN ($1, $2) ORDER BY b.id`,
      [itemA.id, itemB.id],
    );
    const remainingA = batches2.find((b) => b.purchase_item_id === itemA.id)!;
    const remainingB = batches2.find((b) => b.purchase_item_id === itemB.id)!;
    assert.equal(Number(remainingA.quantity_remaining), 4);
    assert.equal(Number(remainingA.additional_cost_per_unit), 30.25);
    assert.equal(Number(remainingB.quantity_remaining), 3);
    assert.equal(Number(remainingB.additional_cost_per_unit), 60.5);

    // netInInventory is batch-authoritative: 121 + 181.50 = 302.50.
    assert.equal(Number(accounting.netInInventory), 302.5);
    // Conservation: 605 = 302.50 in inventory + 181.50 sold + 121 returned.
    assert.equal(Number(accounting.soldUnitsLanded), 181.5);
    assert.equal(
      Number(accounting.postingsByType.capitalization),
      Number(accounting.netInInventory) +
        Number(accounting.soldUnitsLanded) +
        Math.abs(Number(accounting.postingsByType.reversal)),
    );

    // Full inventory valuation = remaining × landed per unit.
    const valuation =
      Number(remainingA.quantity_remaining) *
        Number(remainingA.landed_cost_per_unit) +
      Number(remainingB.quantity_remaining) *
        Number(remainingB.landed_cost_per_unit);
    assert.equal(valuation, 1302.5); // 4 × 130.25 + 3 × 260.50

    // Supplier ledger: the return credit is recorded once.
    const ledger = await dbRows(
      "SELECT transaction_type, credit FROM supplier_ledger WHERE supplier_id = $1 AND business_id = $2",
      [supplierId, owner.businessId],
    );
    const returnCredits = ledger
      .filter((l) => l.transaction_type === "PURCHASE_RETURN")
      .reduce((sum, l) => sum + Number(l.credit), 0);
    assert.equal(returnCredits, 400);

    // Payables: due = grand total − paid − credits (floored at 0).
    const header = await dbRows(
      "SELECT total_amount, paid_amount, due_amount FROM purchases WHERE id = $1",
      [pid],
    );
    const expectedDue = Math.max(
      0,
      Number(header[0]!.total_amount) -
        Number(header[0]!.paid_amount) -
        returnCredits,
    );
    assert.equal(Number(header[0]!.due_amount), expectedDue);
  });

  it("reconciles payables through partial payment and return credit (Phase 12)", async () => {
    const variant = await freshVariant("R2");
    const supplierId = await makeSupplier("R2");
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [{ variantId: variant, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 }],
    });
    assert.equal(purchase.status, 201);
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find((i) => i.purchaseId === pid).id;

    // Partial payment: 400 of 1,000.
    await receivePurchase(pid, itemId, 10, 100, 400);
    let header = await dbRows(
      "SELECT total_amount, paid_amount, due_amount, payment_status FROM purchases WHERE id = $1",
      [pid],
    );
    assert.equal(Number(header[0]!.due_amount), 600);
    assert.equal(header[0]!.payment_status, "partial");

    // Return 3 units → 300 credit reduces the payable.
    const returnData = await returnUnits(pid, itemId, 3);
    assert.equal(Number(returnData.totalAmount), 300);

    header = await dbRows(
      "SELECT paid_amount, due_amount, payment_status FROM purchases WHERE id = $1",
      [pid],
    );
    assert.equal(Number(header[0]!.due_amount), 300); // 600 − 300
    assert.equal(header[0]!.payment_status, "partial");

    // Ledger credits == the return credit; the tie-out:
    // due == grand − paid − credits.
    const ledger = await dbRows(
      "SELECT transaction_type, credit FROM supplier_ledger WHERE supplier_id = $1 AND business_id = $2",
      [supplierId, owner.businessId],
    );
    const credits = ledger.reduce((sum, l) => sum + Number(l.credit), 0);
    assert.equal(credits, 300);
    assert.equal(
      Number(header[0]!.due_amount),
      1000 - Number(header[0]!.paid_amount) - credits,
    );
  });

  it("ties the classification view to the document and the invoice (Phase 12)", async () => {
    // Fixed discount 100, order tax 50, shipping 120, one line 10 @ 200.
    const variant = await freshVariant("R3");
    const supplierId = await makeSupplier("R3");
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId,
      purchaseDate: new Date().toISOString(),
      discount: 100,
      tax: 50,
      shippingCost: 120,
      items: [{ variantId: variant, quantity: 10, purchasePrice: 200, discount: 0, tax: 0 }],
    });
    assert.equal(purchase.status, 201);
    const pid = Number(purchase.body.data.id);
    // 2000 − 100 + 50 + 120 = 2070.
    const header0 = await api(owner, "GET", `/api/purchases/${pid}`);
    assert.equal(Number(header0.body.purchase.totalAmount), 2070);

    const items = await api(owner, "GET", "/api/purchases/items");
    const itemId = (items.body as any[]).find((i) => i.purchaseId === pid).id;
    // The receive-session payment caps at the received balance (the goods
    // value); the tax+shipping remainder (70) stays due.
    await receivePurchase(pid, itemId, 10, 200, 2000);

    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "quantity",
      expenses: [
        { expenseType: "customs", amount: 300, isCapitalizable: true },
        { expenseType: "loading", amount: 80, isCapitalizable: false },
        {
          expenseType: "insurance",
          amount: 50,
          isCapitalizable: true,
          taxAmount: 5,
          taxTreatment: "recoverable",
        },
        {
          expenseType: "handling",
          amount: 40,
          isCapitalizable: true,
          taxAmount: 8,
          taxTreatment: "non_recoverable",
        },
      ],
    });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const docId = doc.body.data.id as number;
    assert.equal(
      (await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status,
      200,
    );
    const detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;

    // Document total (engine base): shipping 120 + customs 300 + insurance
    // 50 + handling 40 + its non-recoverable tax 8 = 518. Recoverable tax
    // excluded; loading expensed.
    assert.equal(Number(detail.data.document.totalCapitalizableAmount), 518);
    assert.equal(Number(detail.data.document.totalExpenseAmount), 590);

    // Classification (acquisition view): the SAME expense rules PLUS the
    // order discount as a negative component and the order tax excluded.
    const totals = detail.data.components.totals;
    assert.equal(Number(totals.capitalizable), 418); // 518 − 100 discount
    assert.equal(Number(totals.recoverableTax), 5);
    // Loading 80 + excluded order tax 50.
    assert.equal(Number(totals.expensed), 130);

    // The designed relationship holds exactly:
    // components.capitalizable + discount == document total.
    assert.equal(
      Number(totals.capitalizable) + 100,
      Number(detail.data.document.totalCapitalizableAmount),
    );

    // Component rules table: discount negative, order tax excluded,
    // shipping capitalized once (no mirror double-count).
    const byKey = new Map<string, any>(
      detail.data.components.components.map((c: any) => [c.sourceKey, c]),
    );
    assert.equal(Number(byKey.get("order_discount")!.amount), -100);
    assert.equal(byKey.get("order_tax")!.inventoryTreatment, "excluded");
    assert.equal(
      byKey.get("shipping_cost")!.inventoryTreatment,
      "capitalized",
    );
    assert.equal(
      detail.data.components.components.filter(
        (c: any) => c.sourceKey === "shipping_cost",
      ).length,
      1,
    );
  });

  it("reconciles the equal method end-to-end with exact sums (Phase 12)", async () => {
    const variantA = await freshVariant("R4A");
    const variantB = await freshVariant("R4B");
    const supplierId = await makeSupplier("R4");
    const purchase = await api(owner, "POST", "/api/purchases", {
      supplierId,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId: variantA, quantity: 10, purchasePrice: 100, discount: 0, tax: 0 },
        { variantId: variantB, quantity: 4, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201);
    const pid = Number(purchase.body.data.id);
    const items = await api(owner, "GET", "/api/purchases/items");
    const itemA = (items.body as any[]).find(
      (i) => i.purchaseId === pid && i.variantId === variantA,
    );
    const itemB = (items.body as any[]).find(
      (i) => i.purchaseId === pid && i.variantId === variantB,
    );
    await receivePurchase(pid, itemA.id, 10, 100, 1000);
    await receivePurchase(pid, itemB.id, 4, 100, 400);

    // Equal method: 280 / 2 lines = 140 per line regardless of quantities.
    const doc = await api(owner, "POST", `/api/purchases/${pid}/landed-cost`, {
      method: "equal",
      expenses: [
        { expenseType: "customs", amount: 280, isCapitalizable: true },
      ],
    });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const docId = doc.body.data.id as number;
    assert.equal(
      (await api(owner, "POST", `/api/landed-costs/${docId}/post`, {})).status,
      200,
    );

    const batches = await dbRows(
      `SELECT purchase_item_id, quantity_received, quantity_remaining, additional_cost_per_unit
       FROM inventory_batches WHERE purchase_item_id IN ($1, $2) ORDER BY id`,
      [itemA.id, itemB.id],
    );
    const perUnitA = Number(
      batches.find((b) => b.purchase_item_id === itemA.id)!.additional_cost_per_unit,
    );
    const perUnitB = Number(
      batches.find((b) => b.purchase_item_id === itemB.id)!.additional_cost_per_unit,
    );
    assert.equal(perUnitA, 14); // 140 / 10
    assert.equal(perUnitB, 35); // 140 / 4

    // Exact sum: per-line money == the expense; accounting ties out.
    const lineMoneyA = perUnitA * 10;
    const lineMoneyB = perUnitB * 4;
    assert.equal(lineMoneyA + lineMoneyB, 280);

    const detail = (await api(owner, "GET", `/api/landed-costs/${docId}`)).body as any;
    assert.equal(detail.data.accounting.capitalizationTiesOut, true);
    assert.equal(
      Number(detail.data.accounting.postingsByType.capitalization),
      280,
    );
    // Nothing sold or returned: inventory holds everything.
    assert.equal(Number(detail.data.accounting.netInInventory), 280);
    assert.equal(Number(detail.data.accounting.soldUnitsLanded), 0);
    assert.equal(Number(detail.data.accounting.postingsByType.reversal), 0);
  });
});
