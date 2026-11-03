/**
 * Smart Procurement Phase 4 — reorder planning dashboard.
 *
 * Verifies the single netting rule shared by suggestions and dashboard:
 * available = (stock − reserved) + outstanding POs + in-transit inbound
 * transfers; status classification (out_of_stock / low_stock /
 * needs_reorder / healthy); suggested quantities honoring configured
 * reorder quantity and refusing to invent one from alert thresholds
 * alone; estimated values from last actual cost; supplier-wise groups;
 * summary counts; filters/pagination; and that /api/reorder-suggestions
 * (refactored to delegate) stays consistent with the dashboard.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("reorder planning dashboard integration", { skip: !runIntegration }, () => {
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

  const uniqueEmail = (prefix: string) =>
    `replan-${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let mainLocationId = 0;
  let warehouseLocationId = 0;
  let unitId = 0;
  let supplierA = 0;
  let supplierB = 0;
  let v1 = 0; // needs_reorder → healthy after outstanding PO
  let v2 = 0; // healthy
  let v3 = 0; // out_of_stock, no suggested quantity (no reorder config)
  let v4 = 0; // needs_reorder → healthy after in-transit transfer

  async function api(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
        ...extraHeaders,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok && res.status >= 400) {
      const errBody = await res.clone().json().catch(() => null);
      console.error(`API ${method} ${path} -> ${res.status}:`, JSON.stringify(errBody));
    }
    return { status: res.status, json: await res.json() };
  }

  async function createProduct(
    name: string,
    qty: number,
    config: { reorderPoint: number | null; reorderQuantity: number | null; alertQuantity: number },
  ): Promise<number> {
    const prodRes = await api("POST", "/api/product", {
      name,
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
          sku: "",
          barcode: null,
          sellingPrice: 100,
          alertQuantity: config.alertQuantity,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: 40,
          quantity: qty,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prodRes.status, 201);
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find(
      (p) => p.name === name,
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    const variantId = (detail.json as { variants: { id: number }[] }).variants[0]!.id;
    if (config.reorderPoint !== null || config.reorderQuantity !== null) {
      const set = await api("PATCH", `/api/variants/${variantId}/reorder-config`, {
        reorderPoint: config.reorderPoint,
        reorderQuantity: config.reorderQuantity,
      });
      assert.equal(set.status, 200);
    }
    return variantId;
  }

  /** Creates and fully receives a purchase, optionally at another location. */
  async function receivePurchase(
    variantId: number,
    price: number,
    quantity: number,
    supplierId: number,
    locationId?: number,
  ) {
    const create = await api("POST", "/api/purchases", {
      items: [{ variantId, quantity, purchasePrice: price, discount: 0, tax: 0 }],
      supplierId,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
    });
    assert.equal(create.status, 201);
    const items = await api("GET", "/api/purchases/items");
    const rows = items.json as { id: number; variantId: number; purchaseId: number }[];
    const line = rows
      .filter((r) => r.variantId === variantId)
      .sort((a, b) => b.id - a.id)[0]!;
    const receive = await api(
      "POST",
      "/api/purchases/receive",
      {
        purchaseId: line.purchaseId,
        items: [
          {
            itemId: line.id,
            trackingType: "none",
            receiveNow: quantity,
            unitCost: price,
            sellingPrice: 100,
            batches: [],
            serialNumbers: [],
          },
        ],
        paymentAmount: 0,
        paymentMethod: "cash",
      },
      locationId ? { "X-Location-Id": String(locationId) } : {},
    );
    assert.equal(receive.status, 201);
    return line.purchaseId;
  }

  /** Creates a purchase and leaves it open (ordered, unreceived). */
  async function createOpenPurchase(
    variantId: number,
    price: number,
    quantity: number,
    supplierId: number,
  ) {
    const create = await api("POST", "/api/purchases", {
      items: [{ variantId, quantity, purchasePrice: price, discount: 0, tax: 0 }],
      supplierId,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
    });
    assert.equal(create.status, 201);
  }

  interface DashboardRow {
    variantId: number;
    currentStock: number;
    reservedQuantity: number;
    outstandingOnOrder: number;
    inTransitQuantity: number;
    availableQuantity: number;
    status: string;
    suggestedQuantity: number | null;
    lastUnitCost: number | null;
    estimatedValue: number | null;
    lastSupplierId: number | null;
  }

  async function getDashboard(query = "") {
    const res = await api("GET", `/api/procurement/reorder-dashboard${query}`);
    assert.equal(res.status, 200);
    return (res.json as { data: {
      summary: {
        outOfStock: number;
        lowStock: number;
        needsReorder: number;
        attentionCount: number;
        noSupplierCount: number;
        missingPriceCount: number;
        totalEstimatedValue: number;
        supplierCount: number;
      };
      suppliers: {
        supplierId: number | null;
        supplierName: string | null;
        itemCount: number;
        totalQuantity: number;
        estimatedValue: number;
      }[];
      data: DashboardRow[];
      total: number;
    } }).data;
  }

  before(async () => {
    const email = uniqueEmail("a");
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Reorder Planning Test",
        email,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    token = ((await login.json()) as { accessToken: string }).accessToken;
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: `Reorder Planning Biz ${Date.now()}` }),
    });
    assert.equal(biz.status, 201);
    businessId = ((await biz.json()) as { business: { id: number } }).business.id;
    const loc = await api("POST", "/api/locations", { name: "Main Store" });
    assert.equal(loc.status, 201);
    const locations = await api("GET", "/api/locations");
    mainLocationId = (locations.json as { data: { id: number }[] }).data[0]!.id;
    const warehouse = await api("POST", "/api/locations", { name: "Warehouse" });
    assert.equal(warehouse.status, 201);
    warehouseLocationId = (warehouse.json as { data: { id: number } }).data.id;

    const unit = await api("POST", "/api/product/unit", {
      unitName: "Piece",
      abbreviation: "Pcs",
    });
    unitId = (unit.json as { data: { value: number } }).data.value;
    const supA = await api("POST", "/api/contacts/supplier", {
      supplierName: "Plan Supplier A",
      phone: "+8801711000031",
      email: null,
      address: null,
    });
    supplierA = (supA.json as { data: { supplierId: number } }).data.supplierId;
    const supB = await api("POST", "/api/contacts/supplier", {
      supplierName: "Plan Supplier B",
      phone: "+8801711000032",
      email: null,
      address: null,
    });
    supplierB = (supB.json as { data: { supplierId: number } }).data.supplierId;

    v1 = await createProduct("Widget Low", 5, { reorderPoint: 10, reorderQuantity: null, alertQuantity: 0 });
    v2 = await createProduct("Widget Ok", 50, { reorderPoint: 10, reorderQuantity: null, alertQuantity: 0 });
    v3 = await createProduct("Widget Out", 1, { reorderPoint: null, reorderQuantity: null, alertQuantity: 3 });
    const adjust = await api("POST", `/api/products/variants/${v3}/adjust-stock`, {
      newQuantity: 0,
      reason: "count_correction",
    });
    assert.equal(adjust.status, 200);
    v4 = await createProduct("Widget Transfer", 2, { reorderPoint: 10, reorderQuantity: null, alertQuantity: 0 });
  });

  it("classifies monitored variants and refuses to invent quantities", async () => {
    const data = await getDashboard();
    assert.equal(data.total, 4); // all four are monitored
    const row1 = data.data.find((r) => r.variantId === v1)!;
    assert.equal(row1.status, "needs_reorder");
    assert.equal(row1.currentStock, 5);
    assert.equal(row1.availableQuantity, 5);
    assert.equal(row1.suggestedQuantity, 5); // 10 − 5
    assert.equal(row1.estimatedValue, null); // never purchased → no cost basis
    const row2 = data.data.find((r) => r.variantId === v2)!;
    assert.equal(row2.status, "healthy");
    const row3 = data.data.find((r) => r.variantId === v3)!;
    assert.equal(row3.status, "out_of_stock");
    assert.equal(row3.suggestedQuantity, null); // no reorder config → buyer decides
    const row4 = data.data.find((r) => r.variantId === v4)!;
    assert.equal(row4.status, "needs_reorder");
    assert.equal(row4.suggestedQuantity, 8);

    assert.deepEqual(
      [data.summary.outOfStock, data.summary.lowStock, data.summary.needsReorder],
      [1, 0, 2],
    );
    assert.equal(data.summary.attentionCount, 3);
    assert.equal(data.summary.noSupplierCount, 3);
    assert.equal(data.summary.missingPriceCount, 3);
    assert.equal(data.summary.totalEstimatedValue, 0);
    assert.equal(data.summary.supplierCount, 0);
    assert.equal(data.suppliers.length, 0); // null-supplier rows are not grouped
  });

  it("estimates value from the last actual cost and groups by supplier", async () => {
    await receivePurchase(v1, 50, 1, supplierA);
    const data = await getDashboard();
    const row1 = data.data.find((r) => r.variantId === v1)!;
    assert.equal(row1.currentStock, 6);
    assert.equal(row1.suggestedQuantity, 4);
    assert.equal(row1.lastUnitCost, 50);
    assert.equal(row1.estimatedValue, 200); // 4 × 50
    assert.equal(row1.lastSupplierId, supplierA);
    assert.equal(data.summary.supplierCount, 1);
    assert.equal(data.summary.totalEstimatedValue, 200);
    assert.equal(data.suppliers.length, 1);
    assert.equal(data.suppliers[0]!.supplierId, supplierA);
    assert.equal(data.suppliers[0]!.itemCount, 1);
    assert.equal(data.suppliers[0]!.estimatedValue, 200);

    // Suggestions delegate to the same computation.
    const suggestions = await api("GET", "/api/reorder-suggestions");
    const list = (suggestions.json as { data: { variantId: number; suggestedQuantity: number }[] }).data;
    assert.deepEqual(
      list
        .map((s) => [s.variantId, s.suggestedQuantity])
        .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)),
      [[v1, 4], [v4, 8]],
    );
  });

  it("nets reserved stock into availability", async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(
      `UPDATE inventory_stock SET reserved_quantity = 10
       WHERE business_id = $1 AND variant_id = $2 AND location_id = $3`,
      [businessId, v1, mainLocationId],
    );
    await client.end();

    const data = await getDashboard();
    const row1 = data.data.find((r) => r.variantId === v1)!;
    assert.equal(row1.reservedQuantity, 10);
    assert.equal(row1.availableQuantity, 0); // 6 − 10 floored at 0
    assert.equal(row1.status, "needs_reorder");
    assert.equal(row1.suggestedQuantity, 10);
    assert.equal(row1.estimatedValue, 500);
  });

  it("nets outstanding purchase orders — no double-ordering", async () => {
    await createOpenPurchase(v1, 50, 25, supplierA); // stays ordered/unreceived
    const data = await getDashboard();
    const row1 = data.data.find((r) => r.variantId === v1)!;
    assert.equal(row1.outstandingOnOrder, 25);
    assert.equal(row1.availableQuantity, 25); // 0 + 25 on order
    assert.equal(row1.status, "healthy");
    assert.equal(data.summary.needsReorder, 1); // only v4 remains
    assert.equal(data.summary.attentionCount, 2); // v3 out + v4 needs
  });

  it("nets in-transit inbound transfers into availability", async () => {
    // Stock the warehouse by receiving there, then ship toward Main Store.
    await receivePurchase(v4, 10, 20, supplierB, warehouseLocationId);
    const transfer = await api("POST", "/api/stock-transfers", {
      fromLocationId: warehouseLocationId,
      toLocationId: mainLocationId,
      items: [{ variantId: v4, quantity: 15 }],
    });
    assert.equal(transfer.status, 201);
    const transferId = (transfer.json as { data: { id: number } }).data.id;
    const ship = await api("POST", `/api/stock-transfers/${transferId}/ship`);
    assert.equal(ship.status, 200);

    const data = await getDashboard();
    const row4 = data.data.find((r) => r.variantId === v4)!;
    assert.equal(row4.currentStock, 2); // shipped stock not added until received
    assert.equal(row4.inTransitQuantity, 15);
    assert.equal(row4.availableQuantity, 17); // 2 + 15 in transit
    assert.equal(row4.status, "healthy");

    assert.equal(data.summary.attentionCount, 1); // only v3 out_of_stock
    assert.equal(data.summary.needsReorder, 0);
    assert.equal(data.summary.noSupplierCount, 1);
    assert.equal(data.summary.missingPriceCount, 1);

    // Suggestions agree with the dashboard.
    const suggestions = await api("GET", "/api/reorder-suggestions");
    assert.equal(
      ((suggestions.json as { data: unknown[] }).data).length,
      0,
    );
  });

  it("filters by status and search, and paginates", async () => {
    const outOfStock = await getDashboard("?status=out_of_stock");
    assert.equal(outOfStock.total, 1);
    assert.equal(outOfStock.data[0]!.variantId, v3);

    const healthy = await getDashboard("?status=healthy");
    assert.equal(healthy.total, 3);

    const searched = await getDashboard("?search=Widget%20Ok");
    assert.equal(searched.total, 1);
    assert.equal(searched.data[0]!.variantId, v2);

    const paged = await getDashboard("?limit=2&page=1");
    assert.equal(paged.data.length, 2);
    assert.equal(paged.data[0]!.variantId, v3); // out_of_stock sorts first

    const bad = await api("GET", "/api/procurement/reorder-dashboard?status=bogus");
    assert.equal(bad.status, 400);
  });

  it("isolates tenants", async () => {
    const email = uniqueEmail("b");
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Reorder Other",
        email,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    const otherToken = ((await login.json()) as { accessToken: string }).accessToken;
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}` },
      body: JSON.stringify({ name: `Reorder Other Biz ${Date.now()}` }),
    });
    assert.equal(biz.status, 201);
    const otherBizId = ((await biz.json()) as { business: { id: number } }).business.id;
    await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${otherToken}`,
        "X-Business-Id": String(otherBizId),
      },
      body: JSON.stringify({ name: "Main Store" }),
    });

    const savedToken = token;
    token = otherToken;
    const savedBiz = businessId;
    businessId = otherBizId;
    const data = await getDashboard();
    assert.equal(data.total, 0);
    assert.equal(data.summary.attentionCount, 0);
    token = savedToken;
    businessId = savedBiz;
  });
});
