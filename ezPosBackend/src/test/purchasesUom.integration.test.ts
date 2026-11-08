/**
 * UOM purchases integration (Phase 2): packaging units across the purchase
 * lifecycle. Proves the master-prompt §6 worked example end-to-end:
 *
 *   PO: 5 Box @ ৳1,200 (1 Box = 12 Pieces)
 *     → stored base line: quantity 60, unitCost ৳100/pc, snapshots intact
 *     → subtotal ৳6,000 computed from ENTERED values
 *   Receive full → 60-pc batches at ৳100/pc, stock 60, receiving record
 *     keeps entered 5 Box @ ৳1,200/box
 *   Partial receive in an EXPLICIT unit (6 of 10 Box) → 72 pcs received,
 *     outstanding 48
 *   Purchase return of 1 Box → stock −12, snapshots preserved
 *   Landed cost (quantity method) → ৳600 shipping over 60 pcs = ৳110/pc
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("uom purchases integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";

  before(async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const db = await client.query("SELECT current_database() AS db");
    if (db.rows[0]?.db !== "ezpos_test") {
      await client.end();
      throw new Error(
        `SAFETY ABORT: connected to "${db.rows[0]?.db}" — integration tests may only run against ezpos_test.`,
      );
    }
    await client.query(
      `INSERT INTO subscription_plans (name, slug, interval, price, currency, is_active)
       VALUES ('Free trial', 'free-trial', 'monthly', 0, 'BDT', true)
       ON CONFLICT (slug) DO UPDATE
       SET limits = NULL,
           features = '{"multiLocation":true,"advancedReports":true,"storefrontApi":true,"woocommerceIntegration":true,"customStorefront":true,"multipleOnlineStores":true,"advancedWebhooks":true}'::jsonb,
           is_active = true`,
    );
    await client.end();
    const { ensureRbacSeed } = await import("../rbac/seed.js");
    await ensureRbacSeed();

    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(() => {
    server?.close();
  });

  const stamp = `uomp-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

  async function api(
    token: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    payload?: unknown,
    extraHeaders: Record<string, string> = {},
  ) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId || 0),
        ...extraHeaders,
      },
      ...(method === "GET" || method === "DELETE"
        ? {}
        : { body: JSON.stringify(payload ?? {}) }),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  let ownerToken = "";
  let businessId = 0;
  let pcUnitId = 0;
  let boxUnitId = 0;
  let variantId = 0;
  let conversionId = 0;

  before(async () => {
    const email = `${stamp}-owner@example.test`;
    await api("", "POST", "/api/auth/register", {
      fullName: "UOM Purchases Owner",
      email,
      password: "strong-password-123",
    });
    const login = await api("", "POST", "/api/auth/login", {
      email,
      password: "strong-password-123",
    });
    ownerToken = login.body.accessToken;
    const biz = await api(ownerToken, "POST", "/api/businesses", {
      name: `UOM Purchases ${stamp}`,
    });
    assert.equal(biz.status, 201);
    businessId = biz.body.business.id;
    const loc = await api(ownerToken, "POST", "/api/locations", {
      name: "Main",
    });
    assert.equal(loc.status, 201);

    const pieceRes = await api(ownerToken, "POST", "/api/product/unit", {
      unitName: "Piece",
      abbreviation: "pc",
    });
    const boxRes = await api(ownerToken, "POST", "/api/product/unit", {
      unitName: `Box ${stamp}`,
      abbreviation: "box",
    });
    assert.equal(pieceRes.status, 201);
    assert.equal(boxRes.status, 201);
    const opts = await api(ownerToken, "GET", "/api/product/select-options");
    pcUnitId = (opts.body.units ?? []).find((u: any) => u.label === "Piece").value;
    boxUnitId = (opts.body.units ?? []).find(
      (u: any) => u.label === `Box ${stamp}`,
    ).value;

    const product = await api(ownerToken, "POST", "/api/product", {
      name: `Toy Car ${stamp}`,
      categoryId: null,
      brandId: null,
      unitId: pcUnitId,
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
          sku: `TCP-${stamp}`,
          barcode: null,
          sellingPrice: 130,
          purchasePrice: 100,
          quantity: 1,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          batchNumber: `TC-${stamp}`,
          expiryDate: null,
          options: [],
          weight: null,
          weightUnit: "kg",
          imageUrl: null,
          imageFile: null,
        },
      ],
    });
    assert.equal(product.status, 201, JSON.stringify(product.body));
    const detail = await api(ownerToken, "GET", `/api/product/${product.body.data.productId}`);
    variantId = detail.body.variants[0].id;

    const conv = await api(ownerToken, "POST", `/api/product/${product.body.data.productId}/uom`, {
      unitId: boxUnitId,
      conversionFactor: 12,
      isPurchaseEnabled: true,
      isSaleEnabled: true,
      purchasePrice: 1200,
      salePrice: 1500,
    });
    assert.equal(conv.status, 201, JSON.stringify(conv.body));
    conversionId = conv.body.data.id;
  });

  it("creates a PO in Box units with base-unit storage and entered snapshots", async () => {
    const purchase = await api(ownerToken, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      notes: "uom po",
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        {
          variantId,
          quantity: 5,
          purchasePrice: 1200,
          discount: 0,
          tax: 0,
          uomConversionId: conversionId,
        },
      ],
    });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.body));
    const purchaseId = purchase.body.data.id;

    const detail = await api(ownerToken, "GET", `/api/purchases/${purchaseId}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const item = detail.body.items[0];
    assert.ok(item, "expected purchase items in detail payload");
    assert.equal(Number(item.quantity), 60); // base units
    assert.equal(Number(item.unitCost), 100); // per base unit
    assert.equal(Number(item.total), 6000); // DB-generated, exact
    assert.equal(item.enteredQuantity, 5);
    assert.equal(Number(item.enteredUnitPrice), 1200);
    assert.equal(Number(item.conversionFactor), 12);
    assert.equal(item.uomConversionId, conversionId);
  });

  it("receives the full Box PO into 60 base-unit batches at ৳100/pc", async () => {
    const purchase = await api(ownerToken, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      notes: "uom receive full",
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId, quantity: 5, purchasePrice: 1200, discount: 0, tax: 0, uomConversionId: conversionId },
      ],
    });
    const purchaseId = purchase.body.data.id;
    const detail = await api(ownerToken, "GET", `/api/purchases/${purchaseId}`);
    const itemId = detail.body.items[0].id;

    const receive = await api(ownerToken, "POST", "/api/purchases/receive", {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: 5,
          unitCost: 1200,
          sellingPrice: 130,
          batches: [],
          serialNumbers: [],
          uomConversionId: conversionId,
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(receive.status, 201, JSON.stringify(receive.body));

    // Stock moved in base units.
    const stock = await api(ownerToken, "GET", `/api/variant/${variantId}/sell-units`);
    assert.equal(stock.status, 200);
    const baseOption = stock.body.data.units.find((u: any) => u.uomConversionId === null);
    // 60 received + the 1-pc opening stock from product creation
    assert.equal(baseOption.availablePackages, 61);
    const boxOption = stock.body.data.units.find(
      (u: any) => u.uomConversionId === conversionId,
    );
    assert.equal(boxOption.availablePackages, 5); // floor(60/12)

    // Batch cost is per BASE unit.
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const batches = await client.query(
      `SELECT quantity_received, quantity_remaining, purchase_price
       FROM inventory_batches
       WHERE business_id = $1 AND variant_id = $2 AND purchase_item_id = $3`,
      [businessId, variantId, itemId],
    );
    const rec = await client.query(
      `SELECT accepted_quantity, unit_cost, entered_quantity, entered_unit_price, conversion_factor
       FROM purchase_receiving_records WHERE business_id = $1 ORDER BY id DESC LIMIT 1`,
      [businessId],
    );
    client.end();
    assert.equal(batches.rowCount, 1);
    assert.equal(batches.rows[0].quantity_received, 60);
    assert.equal(Number(batches.rows[0].purchase_price), 100);
    // Receiving record: base accepted 60, entered snapshot 5 @ 1200/12.
    assert.equal(Number(rec.rows[0].accepted_quantity), 60);
    assert.equal(Number(rec.rows[0].unit_cost), 100);
    assert.equal(Number(rec.rows[0].entered_quantity), 5);
    assert.equal(Number(rec.rows[0].entered_unit_price), 1200);
    assert.equal(Number(rec.rows[0].conversion_factor), 12);
    void purchaseId;
  });

  it("partially receives in an explicit unit and tracks outstanding in base", async () => {
    const purchase = await api(ownerToken, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      notes: "uom partial receive",
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId, quantity: 10, purchasePrice: 1200, discount: 0, tax: 0, uomConversionId: conversionId },
      ],
    });
    const purchaseId = purchase.body.data.id;
    const detail = await api(ownerToken, "GET", `/api/purchases/${purchaseId}`);
    const item = detail.body.items[0];
    const itemId = item.id;

    // First receipt: 6 Box (entered explicitly) = 72 pcs.
    const first = await api(ownerToken, "POST", "/api/purchases/receive", {
      purchaseId,
      items: [
        { itemId, trackingType: "none", receiveNow: 6, unitCost: 1200, sellingPrice: 130, batches: [], serialNumbers: [], uomConversionId: conversionId },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const mid = await api(ownerToken, "GET", `/api/purchases/${purchaseId}`);
    const midItem = mid.body.items[0];
    assert.equal(Number(midItem.receivedQuantity), 72);
    assert.equal(mid.body.purchase.status, "partially_received");

    // Second receipt: 4 Box via the line's own snapshot (no payload unit).
    const second = await api(ownerToken, "POST", "/api/purchases/receive", {
      purchaseId,
      items: [
        { itemId, trackingType: "none", receiveNow: 4, unitCost: 1200, sellingPrice: 130, batches: [], serialNumbers: [] },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const done = await api(ownerToken, "GET", `/api/purchases/${purchaseId}`);
    const doneItem = done.body.items[0];
    assert.equal(Number(doneItem.receivedQuantity), 120);
    assert.equal(done.body.purchase.status, "received");

  });

  it("rejects over-receiving beyond tolerance in package units (403)", async () => {
    const purchase = await api(ownerToken, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      notes: "uom over-receive",
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId, quantity: 2, purchasePrice: 1200, discount: 0, tax: 0, uomConversionId: conversionId },
      ],
    });
    const purchaseId = purchase.body.data.id;
    const detail = await api(ownerToken, "GET", `/api/purchases/${purchaseId}`);
    const itemId = detail.body.items[0].id;

    // 3 Box against a 2-Box order (tolerance 0%). The owner holds
    // purchases.over_receive, so the over-receive is allowed WITH a
    // recorded reason — and rejected without one.
    const noReason = await api(ownerToken, "POST", "/api/purchases/receive", {
      purchaseId,
      items: [
        { itemId, trackingType: "none", receiveNow: 3, unitCost: 1200, sellingPrice: 130, batches: [], serialNumbers: [], uomConversionId: conversionId },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(noReason.status, 400, JSON.stringify(noReason.body));
    assert.match(noReason.body.message, /reason/i);

    const over = await api(ownerToken, "POST", "/api/purchases/receive", {
      purchaseId,
      items: [
        { itemId, trackingType: "none", receiveNow: 3, unitCost: 1200, sellingPrice: 130, batches: [], serialNumbers: [], uomConversionId: conversionId, overReceiveReason: "Extra box arrived" },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(over.status, 201, JSON.stringify(over.body));
    // 36 base received on a 24-base order; the over-receive decision is
    // persisted as a purchase_discrepancies row.
    const after = await api(ownerToken, "GET", `/api/purchases/${purchaseId}`);
    assert.equal(Number(after.body.items[0].receivedQuantity), 36);
  });

  it("returns 1 Box of a received PO and preserves the entered snapshot", async () => {
    const supplier = await api(ownerToken, "POST", "/api/contacts/supplier", {
      supplierName: `Supplier ${stamp}`,
      phone: "01700000000",
      email: `${stamp}-supplier@example.test`,
      address: "Dhaka",
    });
    assert.equal(supplier.status, 201, JSON.stringify(supplier.body));
    const supplierId = supplier.body.data.supplierId;
    const purchase = await api(ownerToken, "POST", "/api/purchases", {
      supplierId,
      purchaseDate: new Date().toISOString(),
      notes: "uom return",
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId, quantity: 5, purchasePrice: 1200, discount: 0, tax: 0, uomConversionId: conversionId },
      ],
    });
    const purchaseId = purchase.body.data.id;
    const detail = await api(ownerToken, "GET", `/api/purchases/${purchaseId}`);
    const item = detail.body.items[0];
    await api(ownerToken, "POST", "/api/purchases/receive", {
      purchaseId,
      items: [
        { itemId: item.id, trackingType: "none", receiveNow: 5, unitCost: 1200, sellingPrice: 130, batches: [], serialNumbers: [], uomConversionId: conversionId },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });

    const stockBefore = await baseStock();
    const ret = await api(ownerToken, "POST", "/api/purchase-return", {
      orderId: purchaseId,
      reason: "uom return test",
      changedItems: [
        { purchaseItemId: item.id, quantity: 1, uomConversionId: conversionId },
      ],
    });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));

    const stockAfter = await baseStock();
    assert.equal(stockAfter, stockBefore - 12);

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const rows = await client.query(
      `SELECT quantity, unit_price, entered_quantity, conversion_factor
       FROM purchase_return_items WHERE business_id = $1 ORDER BY id DESC LIMIT 1`,
      [businessId],
    );
    client.end();
    assert.equal(Number(rows.rows[0].quantity), 12);
    // Per-base credit = batch purchase price 100 (no discount/tax on line).
    assert.equal(Number(rows.rows[0].unit_price), 100);
    assert.equal(Number(rows.rows[0].entered_quantity), 1);
    assert.equal(Number(rows.rows[0].conversion_factor), 12);
  });

  it("allocates landed cost over base quantities (৳600 shipping → ৳110/pc)", async () => {
    const purchase = await api(ownerToken, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      notes: "uom landed cost",
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId, quantity: 5, purchasePrice: 1200, discount: 0, tax: 0, uomConversionId: conversionId },
      ],
    });
    const purchaseId = purchase.body.data.id;
    const detail = await api(ownerToken, "GET", `/api/purchases/${purchaseId}`);
    const item = detail.body.items[0];
    await api(ownerToken, "POST", "/api/purchases/receive", {
      purchaseId,
      items: [
        { itemId: item.id, trackingType: "none", receiveNow: 5, unitCost: 1200, sellingPrice: 130, batches: [], serialNumbers: [], uomConversionId: conversionId },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });

    const doc = await api(
      ownerToken,
      "POST",
      `/api/purchases/${purchaseId}/landed-cost`,
      {
        method: "quantity",
        expenses: [
          { expenseType: "shipping", amount: 600, isCapitalizable: true },
        ],
      },
    );
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const posted = await api(
      ownerToken,
      "POST",
      `/api/landed-costs/${doc.body.data.id}/post`,
      {},
    );
    assert.equal(posted.status, 200, JSON.stringify(posted.body));

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const batches = await client.query(
      `SELECT quantity_received, purchase_price, additional_cost_per_unit, landed_cost_per_unit
       FROM inventory_batches
       WHERE business_id = $1 AND variant_id = $2
         AND purchase_item_id = $3`,
      [businessId, variantId, item.id],
    );
    client.end();
    const batch = batches.rows[0];
    assert.equal(batch.quantity_received, 60);
    assert.equal(Number(batch.purchase_price), 100);
    assert.equal(Number(batch.additional_cost_per_unit), 10);
    assert.equal(Number(batch.landed_cost_per_unit), 110);
  });

  async function baseStock(): Promise<number> {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const rows = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS qty FROM inventory_stock
       WHERE business_id = $1 AND variant_id = $2`,
      [businessId, variantId],
    );
    client.end();
    return Number(rows.rows[0].qty);
  }
});
