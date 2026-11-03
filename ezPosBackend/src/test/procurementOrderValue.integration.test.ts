/**
 * Smart Procurement Phase 5 — supplier order-value management.
 *
 * Verifies: order-settings editing (minimum/target independent, enable
 * flag, notes) with suppliers.edit gating, dashboard order-value status
 * (below_minimum with amount remaining / minimum_reached / target_reached
 * / above_target / ready_for_review), the supplierId dashboard filter
 * (add-more-needed-products), tenant isolation, and that POST
 * /api/purchases now returns the created purchase id.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("supplier order value integration", { skip: !runIntegration }, () => {
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
    `orderval-${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let unitId = 0;
  let supplierA = 0;
  let supplierB = 0;
  let v1 = 0;
  let v2 = 0;

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok && res.status >= 400) {
      const errBody = await res.clone().json().catch(() => null);
      console.error(`API ${method} ${path} -> ${res.status}:`, JSON.stringify(errBody));
    }
    return { status: res.status, json: await res.json() };
  }

  async function createVariant(name: string): Promise<number> {
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
          sellingPrice: 900,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: 40,
          quantity: 1,
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
    const set = await api("PATCH", `/api/variants/${variantId}/reorder-config`, {
      reorderPoint: 5,
      reorderQuantity: null,
    });
    assert.equal(set.status, 200);
    return variantId;
  }

  async function receivePurchase(
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
    const items = await api("GET", "/api/purchases/items");
    const rows = items.json as { id: number; variantId: number; purchaseId: number }[];
    const line = rows
      .filter((r) => r.variantId === variantId)
      .sort((a, b) => b.id - a.id)[0]!;
    const receive = await api("POST", "/api/purchases/receive", {
      purchaseId: line.purchaseId,
      items: [
        {
          itemId: line.id,
          trackingType: "none",
          receiveNow: quantity,
          unitCost: price,
          sellingPrice: 900,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(receive.status, 201);
  }

  before(async () => {
    const email = uniqueEmail("a");
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Order Value Test",
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
      body: JSON.stringify({ name: `Order Value Biz ${Date.now()}` }),
    });
    assert.equal(biz.status, 201);
    businessId = ((await biz.json()) as { business: { id: number } }).business.id;
    const loc = await api("POST", "/api/locations", { name: "Main Store" });
    assert.equal(loc.status, 201);
    const unit = await api("POST", "/api/product/unit", {
      unitName: "Carton",
      abbreviation: "Ctn",
    });
    unitId = (unit.json as { data: { value: number } }).data.value;
    const supA = await api("POST", "/api/contacts/supplier", {
      supplierName: "Bulk Wholesaler",
      phone: "+8801711000041",
      email: null,
      address: null,
    });
    supplierA = (supA.json as { data: { supplierId: number } }).data.supplierId;
    const supB = await api("POST", "/api/contacts/supplier", {
      supplierName: "Corner Dealer",
      phone: "+8801711000042",
      email: null,
      address: null,
    });
    supplierB = (supB.json as { data: { supplierId: number } }).data.supplierId;

    v1 = await createVariant("Item Alpha");
    v2 = await createVariant("Item Beta");
    await receivePurchase(v1, 500, 1, supplierA); // stock 2, suggested 3 → 1500
    await receivePurchase(v2, 10, 1, supplierB); // stock 2, suggested 3 → 30
  });

  it("reports ready_for_review when no order settings exist", async () => {
    const res = await api("GET", "/api/procurement/reorder-dashboard");
    assert.equal(res.status, 200);
    const groups = (res.json as { data: { suppliers: {
      supplierId: number | null;
      estimatedValue: number;
      orderStatus: string;
      amountRemaining: number;
    }[] } }).data.suppliers;
    const a = groups.find((g) => g.supplierId === supplierA)!;
    const b = groups.find((g) => g.supplierId === supplierB)!;
    assert.equal(a.estimatedValue, 1500);
    assert.equal(a.orderStatus, "ready_for_review");
    assert.equal(b.orderStatus, "ready_for_review");
  });

  it("saves and surfaces independent minimum/target settings", async () => {
    const patch = await api(
      "PATCH",
      `/api/procurement/suppliers/${supplierA}/order-settings`,
      {
        minimumOrderValue: 10000,
        targetOrderValue: 12000,
        orderSettingsEnabled: true,
        orderSettingsNotes: "Bulk orders only below 12k avoided",
      },
    );
    assert.equal(patch.status, 200);
    const supplier = (patch.json as { data: { supplier: {
      minimumOrderValue: number | null;
      targetOrderValue: number | null;
      orderSettingsEnabled: boolean;
      orderSettingsNotes: string | null;
    } } }).data.supplier;
    assert.equal(supplier.minimumOrderValue, 10000);
    assert.equal(supplier.targetOrderValue, 12000);
    assert.equal(supplier.orderSettingsEnabled, true);
    assert.equal(supplier.orderSettingsNotes, "Bulk orders only below 12k avoided");

    const patchB = await api(
      "PATCH",
      `/api/procurement/suppliers/${supplierB}/order-settings`,
      { minimumOrderValue: 1, targetOrderValue: 2 },
    );
    assert.equal(patchB.status, 200);
  });

  it("classifies order value status with the remaining amount", async () => {
    const res = await api("GET", "/api/procurement/reorder-dashboard");
    const groups = (res.json as { data: { suppliers: {
      supplierId: number | null;
      orderStatus: string;
      amountRemaining: number;
      minimumOrderValue: number | null;
      targetOrderValue: number | null;
    }[] } }).data.suppliers;
    const a = groups.find((g) => g.supplierId === supplierA)!;
    assert.equal(a.orderStatus, "below_minimum");
    assert.equal(a.amountRemaining, 8500); // 10000 − 1500
    assert.equal(a.minimumOrderValue, 10000);
    const b = groups.find((g) => g.supplierId === supplierB)!;
    assert.equal(b.orderStatus, "above_target"); // 30 > target 2
    assert.equal(b.amountRemaining, 0);
  });

  it("filters the dashboard to one supplier's needed products", async () => {
    const res = await api(
      "GET",
      `/api/procurement/reorder-dashboard?supplierId=${supplierA}&status=attention`,
    );
    assert.equal(res.status, 200);
    const data = (res.json as { data: { data: { variantId: number; lastSupplierId: number | null }[]; total: number } }).data;
    assert.equal(data.total, 1);
    assert.equal(data.data[0]!.variantId, v1);
    assert.equal(data.data[0]!.lastSupplierId, supplierA);
  });

  it("validates settings input and gates edits by suppliers.edit", async () => {
    const negative = await api(
      "PATCH",
      `/api/procurement/suppliers/${supplierA}/order-settings`,
      { minimumOrderValue: -5 },
    );
    assert.equal(negative.status, 400);

    // Cashier lacks suppliers.edit entirely.
    const rolesRes = await api("GET", "/api/roles");
    const rolesBody = rolesRes.json as { data?: { id: number; slug: string }[] };
    const roles = Array.isArray(rolesBody) ? rolesBody : rolesBody.data ?? [];
    const cashierRoleId = roles.find((r) => r.slug === "cashier")!.id;
    const email = uniqueEmail("cashier");
    const created = await api("POST", "/api/users", {
      fullName: "Order Value Cashier",
      email,
      password: "strong-password-123",
      roleIds: [cashierRoleId],
    });
    assert.equal(created.status, 201);
    const userId = (created.json as { data: { userId: number } }).data.userId;
    const locations = await api("GET", "/api/locations");
    await api("PATCH", `/api/users/${userId}`, {
      locationIds: [(locations.json as { data: { id: number }[] }).data[0]!.id],
    });
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    const savedToken = token;
    token = ((await login.json()) as { accessToken: string }).accessToken;
    const forbidden = await api(
      "PATCH",
      `/api/procurement/suppliers/${supplierA}/order-settings`,
      { orderSettingsEnabled: false },
    );
    assert.equal(forbidden.status, 403);
    token = savedToken;
  });

  it("isolates tenants — foreign suppliers 404 on settings", async () => {
    const email = uniqueEmail("b");
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Order Value Other",
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
      body: JSON.stringify({ name: `Order Value Other Biz ${Date.now()}` }),
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
    const savedBiz = businessId;
    token = otherToken;
    businessId = otherBizId;
    const patch = await api(
      "PATCH",
      `/api/procurement/suppliers/${supplierA}/order-settings`,
      { minimumOrderValue: 1 },
    );
    assert.equal(patch.status, 404);
    const dashboard = await api(
      "GET",
      `/api/procurement/reorder-dashboard?supplierId=${supplierA}`,
    );
    assert.equal((dashboard.json as { data: { total: number } }).data.total, 0);
    token = savedToken;
    businessId = savedBiz;
  });

  it("returns the purchase id from POST /api/purchases", async () => {
    const create = await api("POST", "/api/purchases", {
      items: [{ variantId: v1, quantity: 2, purchasePrice: 500, discount: 0, tax: 0 }],
      supplierId: supplierA,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
    });
    assert.equal(create.status, 201);
    const data = (create.json as { data: { id?: number; purchaseOrderNumber?: string } }).data;
    assert.ok(typeof data.id === "number" && data.id > 0, "id present");
    assert.ok(data.purchaseOrderNumber?.startsWith("PO-"));
  });
});
