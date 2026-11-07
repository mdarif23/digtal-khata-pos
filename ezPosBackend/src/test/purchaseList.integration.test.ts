/**
 * Purchase-list aggregation integration tests (Phase 4): the grouped
 * summary endpoint — DB-level quantity/return aggregates, server-side
 * receiving/return status, fullyCancelled, tenant isolation, and the
 * over-receiving outstanding clamp — against a REAL PostgreSQL database.
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

describe("purchase list aggregation integration", { skip: !runIntegration }, () => {
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
    items: { variantId: number; quantity: number; purchasePrice: number }[],
  ): Promise<number> {
    const { status, body } = await postJson(baseUrl, ctx, "/api/purchases", {
      items,
      supplierId,
      purchaseDate: new Date().toISOString(),
    });
    assert.equal(status, 201, `purchase create failed: ${JSON.stringify(body)}`);
    return Number(body.data.id);
  }

  async function listPage(
    ctx: OwnerCtx,
    query = "",
  ): Promise<{
    data: any[];
    pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
    counts: Record<string, number>;
    summary: { totalPurchases: number; awaitingReceipt: number; outstandingBalance: number };
  }> {
    const res = await getJson(
      baseUrl,
      ctx,
      `/api/purchases/list${query ? `?${query}` : ""}`,
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  }

  async function listFor(ctx: OwnerCtx) {
    const page = await listPage(ctx);
    return page.data as any[];
  }

  async function dbRows(query: string, params: unknown[] = []) {
    const { rows } = await pg!.query(query, params as never[]);
    return rows;
  }

  it("aggregates quantities and return status server-side (no item lines shipped)", async () => {
    const owner = await createOwnerCtx(baseUrl, `List Agg ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const v1 = await seedVariant(owner.businessId);
    const v2 = await seedVariant(owner.businessId);
    // Two lines: 10 @ 100 and 5 @ 200.
    const purchaseId = await createPurchase(owner, supplierId, [
      { variantId: v1, quantity: 10, purchasePrice: 100 },
      { variantId: v2, quantity: 5, purchasePrice: 200 },
    ]);
    const itemRows = (await dbRows(
      "SELECT id, variant_id FROM purchase_items WHERE purchase_id = $1 ORDER BY id",
      [purchaseId],
    )) as { id: number; variant_id: number }[];
    const item1 = itemRows.find((r) => r.variant_id === v1)!.id;
    const item2 = itemRows.find((r) => r.variant_id === v2)!.id;

    // Receive 3 of item1; receive 2 of item2 and reject 1.
    const received = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId,
      items: [
        { itemId: item1, trackingType: "none", receiveNow: 3, unitCost: 100, sellingPrice: 150, batches: [], serialNumbers: [] },
        {
          itemId: item2,
          trackingType: "none",
          receiveNow: 2,
          rejectedQuantity: 1,
          rejectionCategory: "damaged",
          rejectionReason: "crushed",
          unitCost: 200,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(received.status, 201, JSON.stringify(received.body));

    // Return 2 of item1's accepted units.
    const ret = await postJson(baseUrl, owner, "/api/purchase-return", {
      orderId: purchaseId,
      reason: "list aggregation test",
      changedItems: [{ purchaseItemId: item1, quantity: 2 }],
    });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));

    const rows = await listFor(owner);
    const row = rows.find((p) => p.id === purchaseId);
    assert.ok(row, "purchase missing from the aggregated list");

    assert.equal(row.totalItems, 2);
    assert.equal(row.orderedQuantity, 15);
    assert.equal(row.acceptedReceivedQuantity, 5); // 3 + 2
    assert.equal(row.rejectedQuantity, 1);
    assert.equal(row.returnedQuantity, 2);
    assert.equal(row.cancelledQuantity, 0);
    assert.equal(row.outstandingQuantity, 10); // 15 − 5 accepted − 0 cancelled
    assert.equal(row.receivingStatus, "partially_received");
    assert.equal(row.returnStatus, "Partially returned");
    assert.equal(row.fullyCancelled, false);

    // Header financials carried through; supplier + phone exposed.
    assert.equal(row.totalAmount, 2000); // 10×100 + 5×200 (never mutated)
    assert.equal(row.dueAmount, 1800); // net of the 200 return credit
    assert.equal(row.paymentStatus, "unpaid");
    assert.equal(row.supplierId, supplierId);
    assert.ok(row.supplierName, "supplier name missing");
    assert.ok(row.supplierPhone, "supplier phone missing");
    assert.equal(row.landedCostStatus, null); // no document

    // The summary row must NOT contain item-line arrays.
    assert.equal(row.items, undefined);
    assert.equal(row.lines, undefined);
  });

  it("marks fully returned purchases (Scenario C) and sums multiple returns (Scenario H)", async () => {
    const owner = await createOwnerCtx(baseUrl, `List Returned ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);
    const purchaseId = await createPurchase(owner, supplierId, [
      { variantId, quantity: 10, purchasePrice: 100 },
    ]);
    const itemId = (
      (await dbRows("SELECT id FROM purchase_items WHERE purchase_id = $1", [
        purchaseId,
      ])) as { id: number }[]
    )[0]!.id;

    const received = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId,
      items: [
        { itemId, trackingType: "none", receiveNow: 10, unitCost: 100, sellingPrice: 150, batches: [], serialNumbers: [] },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(received.status, 201);

    // Two separate returns against the same item: 4 then 6.
    for (const qty of [4, 6]) {
      const ret = await postJson(baseUrl, owner, "/api/purchase-return", {
        orderId: purchaseId,
        reason: "scenario H",
        changedItems: [{ purchaseItemId: itemId, quantity: qty }],
      });
      assert.equal(ret.status, 201, JSON.stringify(ret.body));
    }

    const rows = await listFor(owner);
    const row = rows.find((p) => p.id === purchaseId);
    assert.ok(row);
    assert.equal(row.returnedQuantity, 10); // summed, no duplicate counting
    assert.equal(row.returnStatus, "Returned");
    // Receiving status is INDEPENDENT: still fully received.
    assert.equal(row.receivingStatus, "received");
  });

  it("flags fully-cancelled purchases and clamps outstanding at zero (Scenarios F + G)", async () => {
    const owner = await createOwnerCtx(baseUrl, `List Cancel ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);

    // Scenario F: ordered 10, nothing received, all cancelled.
    const cancelledPo = await createPurchase(owner, supplierId, [
      { variantId, quantity: 10, purchasePrice: 100 },
    ]);
    const cancelledItem = (
      (await dbRows("SELECT id FROM purchase_items WHERE purchase_id = $1", [
        cancelledPo,
      ])) as { id: number }[]
    )[0]!.id;
    const resolved = await postJson(
      baseUrl,
      owner,
      `/api/purchases/${cancelledPo}/outstanding-resolution`,
      {
        items: [
          { purchaseItemId: cancelledItem, quantity: 10, resolution: "cancel", reason: "cancelled" },
        ],
      },
    );
    assert.equal(resolved.status, 200);

    // Scenario G: ordered 4, accepted 6 (over-receive) — outstanding 0, not negative.
    const overPo = await createPurchase(owner, supplierId, [
      { variantId, quantity: 4, purchasePrice: 100 },
    ]);
    const overItem = (
      (await dbRows("SELECT id FROM purchase_items WHERE purchase_id = $1", [
        overPo,
      ])) as { id: number }[]
    )[0]!.id;
    const over = await postJson(baseUrl, owner, "/api/purchases/receive", {
      purchaseId: overPo,
      items: [
        {
          itemId: overItem,
          trackingType: "none",
          receiveNow: 6,
          unitCost: 100,
          sellingPrice: 150,
          batches: [],
          serialNumbers: [],
          overReceiveReason: "full case",
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(over.status, 201, JSON.stringify(over.body));

    const rows = await listFor(owner);

    const cancelledRow = rows.find((p) => p.id === cancelledPo);
    assert.ok(cancelledRow);
    assert.equal(cancelledRow.fullyCancelled, true);
    assert.equal(cancelledRow.receivingStatus, "received"); // workflow state (unchanged enum)
    assert.equal(cancelledRow.acceptedReceivedQuantity, 0);
    assert.equal(cancelledRow.cancelledQuantity, 10);
    assert.equal(cancelledRow.outstandingQuantity, 0);

    const overRow = rows.find((p) => p.id === overPo);
    assert.ok(overRow);
    assert.equal(overRow.fullyCancelled, false);
    assert.equal(overRow.acceptedReceivedQuantity, 6); // never capped at ordered
    assert.equal(overRow.orderedQuantity, 4);
    assert.equal(overRow.outstandingQuantity, 0); // clamped, not negative
  });

  it("exposes landed-cost status and isolates tenants", async () => {
    const ownerA = await createOwnerCtx(baseUrl, `List TenantA ${Date.now()}`);
    const ownerB = await createOwnerCtx(baseUrl, `List TenantB ${Date.now()}`);
    const variantA = await seedVariant(ownerA.businessId);
    const variantB = await seedVariant(ownerB.businessId);

    const poA = await createPurchase(ownerA, null, [
      { variantId: variantA, quantity: 5, purchasePrice: 100 },
    ]);
    await createPurchase(ownerB, null, [
      { variantId: variantB, quantity: 7, purchasePrice: 100 },
    ]);
    const itemA = (
      (await dbRows("SELECT id FROM purchase_items WHERE purchase_id = $1", [
        poA,
      ])) as { id: number }[]
    )[0]!.id;
    await postJson(baseUrl, ownerA, "/api/purchases/receive", {
      purchaseId: poA,
      items: [
        { itemId: itemA, trackingType: "none", receiveNow: 5, unitCost: 100, sellingPrice: 150, batches: [], serialNumbers: [] },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    // Post a landed-cost document → allocated.
    const doc = await postJson(
      baseUrl,
      ownerA,
      `/api/purchases/${poA}/landed-cost`,
      {
        method: "quantity",
        expenses: [
          { expenseType: "shipping", amount: 50, isCapitalizable: true },
        ],
      },
    );
    assert.equal(doc.status, 201);
    const docId = Number(doc.body.data.id);
    assert.equal(
      (await postJson(baseUrl, ownerA, `/api/landed-costs/${docId}/post`, {}))
        .status,
      200,
    );

    const rowsA = await listFor(ownerA);
    const rowA = rowsA.find((p) => p.id === poA);
    assert.ok(rowA);
    assert.equal(rowA.landedCostStatus, "allocated");
    assert.equal(rowsA.some((p) => p.id !== poA), false, "tenant A sees foreign rows");

    const rowsB = await listFor(ownerB);
    assert.equal(rowsB.some((p) => p.id === poA), false, "tenant B sees tenant A's purchase");
  });

  /* ------------------------------------------------------------------
   * Phase 5 — server-side pagination, filtering, sorting, summary scope.
   * ------------------------------------------------------------------ */

  async function seedFilterScenario(): Promise<OwnerCtx> {
    const owner = await createOwnerCtx(baseUrl, `List Page ${Date.now()}`);
    const supplierId = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);

    const mk = async (
      qty: number,
      price: number,
    ): Promise<{ po: number; itemId: number }> => {
      const po = await createPurchase(owner, supplierId, [
        { variantId, quantity: qty, purchasePrice: price },
      ]);
      const itemId = (
        (await dbRows("SELECT id FROM purchase_items WHERE purchase_id = $1", [
          po,
        ])) as { id: number }[]
      )[0]!.id;
      return { po, itemId };
    };
    const receive = async (po: number, itemId: number, receiveNow: number) => {
      const res = await postJson(baseUrl, owner, "/api/purchases/receive", {
        purchaseId: po,
        items: [
          { itemId, trackingType: "none", receiveNow, unitCost: 100, sellingPrice: 150, batches: [], serialNumbers: [] },
        ],
        paymentAmount: 0,
        paymentMethod: "cash",
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    };
    const returnQty = async (po: number, itemId: number, qty: number) => {
      const res = await postJson(baseUrl, owner, "/api/purchase-return", {
        orderId: po,
        reason: "phase 5",
        changedItems: [{ purchaseItemId: itemId, quantity: qty }],
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    };
    const cancelOutstanding = async (po: number, itemId: number, qty: number) => {
      const res = await postJson(
        baseUrl,
        owner,
        `/api/purchases/${po}/outstanding-resolution`,
        { items: [{ purchaseItemId: itemId, quantity: qty, resolution: "cancel", reason: "cancelled" }] },
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
    };

    // PO1: received, no returns. due 1000.
    const a = await mk(10, 100);
    await receive(a.po, a.itemId, 10);
    // PO2: received, partially returned (3). due 700.
    const b = await mk(10, 100);
    await receive(b.po, b.itemId, 10);
    await returnQty(b.po, b.itemId, 3);
    // PO3: fully returned. due 0.
    const c = await mk(10, 100);
    await receive(c.po, c.itemId, 10);
    await returnQty(c.po, c.itemId, 10);
    // PO4: partially received. due 1000.
    const d = await mk(10, 100);
    await receive(d.po, d.itemId, 6);
    // PO5: fully cancelled, zero goods. due 0.
    const e = await mk(10, 100);
    await cancelOutstanding(e.po, e.itemId, 10);

    void supplierId;
    return owner;
  }

  it("paginates with stable sorting, page math, and accurate counts/summary", async () => {
    const owner = await seedFilterScenario();

    const page1 = await listPage(owner, "page=1&pageSize=2");
    assert.equal(page1.pagination.totalItems, 5);
    assert.equal(page1.pagination.totalPages, 3);
    assert.equal(page1.data.length, 2);
    // Newest first; ties broken by id descending (all created back-to-back).
    const allDesc = await listPage(owner, "pageSize=100");
    const ids = allDesc.data.map((p) => p.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));

    // Counts describe the full filtered set (search/supplier/date scoped —
    // never the page, never the active status tab).
    assert.deepEqual(page1.counts, {
      all: 5,
      ordered: 0,
      partially_received: 1,
      received: 2, // PO1 + PO2 — PO3 (fully returned) and PO5 (cancelled) excluded
      partially_returned: 1,
      returned: 1,
      cancelled: 1,
    });
    assert.equal(page1.summary.totalPurchases, 5);
    assert.equal(page1.summary.awaitingReceipt, 1); // PO4 only
    assert.equal(page1.summary.outstandingBalance, 2700); // 1000+700+0+1000+0
  });

  it("filters by receiving status with tab semantics (Received excludes returned/cancelled)", async () => {
    const owner = await seedFilterScenario();

    const received = await listPage(owner, "receivingStatus=received");
    assert.deepEqual(
      received.data.map((p) => p.receivingStatus),
      ["received", "received"],
    );
    assert.equal(received.data.some((p) => p.fullyCancelled), false);
    assert.equal(received.data.some((p) => p.returnStatus === "Returned"), false);

    const partial = await listPage(owner, "receivingStatus=partially_received");
    assert.equal(partial.data.length, 1);
    assert.equal(partial.data[0].acceptedReceivedQuantity, 6);
  });

  it("filters by return status and cancellation flag", async () => {
    const owner = await seedFilterScenario();

    const returned = await listPage(owner, "returnStatus=Returned");
    assert.equal(returned.data.length, 1);
    assert.equal(returned.data[0].returnStatus, "Returned");

    const partial = await listPage(owner, "returnStatus=Partially%20returned");
    assert.equal(partial.data.length, 1);
    assert.equal(partial.data[0].returnStatus, "Partially returned");

    const cancelled = await listPage(owner, "fullyCancelled=true");
    assert.equal(cancelled.data.length, 1);
    assert.equal(cancelled.data[0].fullyCancelled, true);
    assert.equal(cancelled.data[0].acceptedReceivedQuantity, 0);

    const notCancelled = await listPage(owner, "fullyCancelled=false");
    assert.equal(notCancelled.data.length, 4);
  });

  it("searches across PO number, supplier name/phone, and product SKU", async () => {
    const owner = await seedFilterScenario();

    // Supplier name fragment — every PO in the business shares the supplier.
    const bySupplier = await listPage(owner, "search=Supplier");
    assert.equal(bySupplier.data.length, 5);

    // Supplier phone fragment (the seeded phone prefix).
    const byPhone = await listPage(owner, "search=%2B8801711");
    assert.equal(byPhone.data.length, 5);

    // SKU fragment — the seeded SKU prefix.
    const bySku = await listPage(owner, "search=SKU-");
    assert.equal(bySku.data.length, 5);

    // No match anywhere.
    const none = await listPage(owner, "search=zzz-no-match");
    assert.equal(none.data.length, 0);
    assert.equal(none.pagination.totalItems, 0);
    assert.deepEqual(none.counts, {
      all: 0,
      ordered: 0,
      partially_received: 0,
      received: 0,
      partially_returned: 0,
      returned: 0,
      cancelled: 0,
    });
  });

  it("sorts by whitelisted columns with a stable tie-breaker", async () => {
    const owner = await seedFilterScenario();

    // Every PO totals 1000 — all tie on totalAmount; the id tie-breaker
    // keeps the order deterministic.
    const sorted = await listPage(owner, "sortBy=totalAmount&sortOrder=asc");
    const totals = sorted.data.map((p) => p.totalAmount);
    assert.deepEqual(totals, [...totals].sort((a, b) => a - b));
    const ids = sorted.data.map((p) => p.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b)); // tie-breaker

    const byPo = await listPage(
      owner,
      "sortBy=purchaseOrderNumber&sortOrder=asc",
    );
    const numbers = byPo.data.map((p) => p.purchaseOrderNumber);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a.localeCompare(b)));
  });

  it("validates query parameters and scopes the summary to the filters", async () => {
    const owner = await seedFilterScenario();

    // Invalid: page 0, oversized pageSize, bad enum, unknown sort column.
    for (const bad of [
      "page=0",
      "pageSize=150",
      "receivingStatus=nonsense",
      "sortBy=password_hash",
    ]) {
      const res = await getJson(baseUrl, owner, `/api/purchases/list?${bad}`);
      assert.equal(res.status, 400, `expected 400 for ${bad}`);
    }

    // Summary scope: filters narrow the summary, pagination does not.
    const filtered = await listPage(
      owner,
      "receivingStatus=received&pageSize=1&page=1",
    );
    assert.equal(filtered.data.length, 1); // page size applied
    assert.equal(filtered.summary.totalPurchases, 2); // not the page count
    assert.equal(filtered.summary.awaitingReceipt, 0);
    assert.ok(filtered.summary.outstandingBalance > 0);
  });

  /* ------------------------------------------------------------------
   * Phase 9 — checklist gaps: supplier filter, date filtering, and the
   * location-access rule on the list endpoint.
   * ------------------------------------------------------------------ */

  it("filters by supplier", async () => {
    const owner = await createOwnerCtx(baseUrl, `List SupplierF ${Date.now()}`);
    const supplierA = await createSupplier(owner);
    const supplierB = await createSupplier(owner);
    const variantId = await seedVariant(owner.businessId);

    const poA = await createPurchase(owner, supplierA, [
      { variantId, quantity: 5, purchasePrice: 100 },
    ]);
    const poB = await createPurchase(owner, supplierB, [
      { variantId, quantity: 7, purchasePrice: 100 },
    ]);

    const rows = await listPage(owner, `supplierId=${supplierA}`);
    assert.equal(rows.data.length, 1);
    assert.equal(rows.data[0].id, poA);
    assert.equal(rows.data[0].supplierId, supplierA);
    assert.equal(rows.data.some((p) => p.id === poB), false);

    // Unknown supplier id → empty, not an error.
    const none = await listPage(owner, "supplierId=999999");
    assert.equal(none.data.length, 0);
  });

  it("filters by purchase date range", async () => {
    const owner = await createOwnerCtx(baseUrl, `List DateF ${Date.now()}`);
    const variantId = await seedVariant(owner.businessId);
    await createPurchase(owner, null, [
      { variantId, quantity: 5, purchasePrice: 100 },
    ]);

    // All created today: a range ending yesterday sees nothing; starting
    // yesterday sees everything.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const none = await listPage(owner, `dateFrom=${tomorrow}`);
    assert.equal(none.data.length, 0);

    const all = await listPage(owner, `dateFrom=${yesterday}&dateTo=${tomorrow}`);
    assert.equal(all.data.length, 1);
  });

  it("serves the list for an explicitly selected business location", async () => {
    const owner = await createOwnerCtx(baseUrl, `List Loc ${Date.now()}`);
    const variantId = await seedVariant(owner.businessId);
    await createPurchase(owner, null, [
      { variantId, quantity: 5, purchasePrice: 100 },
    ]);

    // A second location of the same business — the list spans the whole
    // business, so selecting either location yields the same rows.
    const branch = await postJson(baseUrl, owner, "/api/locations", {
      name: "List Branch",
    });
    assert.equal(branch.status, 201);
    const branchId =
      branch.body?.data?.id ?? branch.body?.data?.location?.id;
    assert.ok(branchId, "branch location id missing");

    const res = await fetch(`${baseUrl}/api/purchases/list`, {
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "X-Business-Id": String(owner.businessId),
        "X-Location-Id": String(branchId),
      },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { id: number }[] };
    assert.equal(body.data.length, 1);
  });
});


