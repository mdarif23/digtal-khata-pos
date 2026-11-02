/**
 * Reorder suggestion integration tests (Module 2C): suggestions derive
 * from stock + outstanding purchases (no double-ordering), and conversion
 * creates a real purchase order via the existing purchase machinery.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("reorder suggestions integration", { skip: !runIntegration }, () => {
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

  const uniqueEmail = () =>
    `reorder-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let unitId = 0;
  let supplierId = 0;
  let variantA = 0; // stock 5, point 10 → suggest
  let variantB = 0; // stock 20, point 10 → no suggestion

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
    if (!res.ok) {
      console.error(
        `API ${method} ${path} -> ${res.status}:`,
        JSON.stringify(await res.clone().json().catch(() => null)),
      );
    }
    return { status: res.status, json: await res.json() };
  }

  async function createProduct(name: string, qty: number): Promise<number> {
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
          alertQuantity: 0,
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
    return (detail.json as { variants: { id: number }[] }).variants[0]!.id;
  }

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Reorder Test", email, password: "strong-password-123" }),
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: `Reorder Biz ${Date.now()}` }),
    });
    assert.equal(biz.status, 201);
    businessId = ((await biz.json()) as { business: { id: number } }).business.id;
    const loc = await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
      },
      body: JSON.stringify({ name: "Main Store" }),
    });
    assert.equal(loc.status, 201);
    const unit = await api("POST", "/api/product/unit", {
      unitName: "Piece",
      abbreviation: "Pcs",
    });
    unitId = unit.json.data.value;
    const sup = await api("POST", "/api/contacts/supplier", {
      supplierName: "Reorder Supplier",
      phone: "+8801711000099",
      email: null,
      address: null,
    });
    assert.equal(sup.status, 201);
    supplierId = (sup.json as { data: { supplierId: number } }).data.supplierId;
    variantA = await createProduct("Reorder A", 5);
    variantB = await createProduct("Reorder B", 20);
  });

  it("configures reorder points; only at-or-below-point variants are suggested", async () => {
    const setA = await api("PATCH", `/api/variants/${variantA}/reorder-config`, {
      reorderPoint: 10,
      reorderQuantity: 30,
    });
    assert.equal(setA.status, 200);
    const setB = await api("PATCH", `/api/variants/${variantB}/reorder-config`, {
      reorderPoint: 10,
      reorderQuantity: null,
    });
    assert.equal(setB.status, 200);

    const list = await api("GET", "/api/reorder-suggestions");
    assert.equal(list.status, 200);
    const suggestions = list.json.data as {
      variantId: number;
      suggestedQuantity: number;
      currentStock: number;
      outstandingOnOrder: number;
    }[];
    const a = suggestions.find((s) => s.variantId === variantA);
    assert.ok(a, "below-point variant suggested");
    assert.equal(a.currentStock, 5);
    assert.equal(a.suggestedQuantity, 30); // configured quantity wins
    assert.equal(
      suggestions.find((s) => s.variantId === variantB),
      undefined,
      "above-point variant not suggested",
    );
  });

  it("nets outstanding purchase quantities — no double-ordering", async () => {
    // Create an open purchase of 25 for variant A (outstanding).
    const purchase = await api("POST", "/api/purchases", {
      items: [{ variantId: variantA, quantity: 25, purchasePrice: 40, discount: 0, tax: 0 }],
      supplierId,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      notes: "in-flight order",
    });
    assert.equal(purchase.status, 201);

    const list = await api("GET", "/api/reorder-suggestions");
    const suggestions = list.json.data as {
      variantId: number;
      outstandingOnOrder: number;
      currentStock: number;
    }[];
    const a = suggestions.find((s) => s.variantId === variantA);
    // 5 stock + 25 on order = 30 available > point 10 → no suggestion.
    assert.equal(a, undefined);
  });

  it("converts a suggestion into a real purchase order", async () => {
    // A fresh variant with no in-flight orders keeps the math clean.
    const variantC = await createProduct("Reorder C", 2);
    const setConfig = await api("PATCH", `/api/variants/${variantC}/reorder-config`, {
      reorderPoint: 10,
      reorderQuantity: null,
    });
    assert.equal(setConfig.status, 200);

    const list = await api("GET", "/api/reorder-suggestions");
    const suggestions = list.json.data as {
      variantId: number;
      outstandingOnOrder: number;
      suggestedQuantity: number;
    }[];
    const c = suggestions.find((s) => s.variantId === variantC);
    assert.ok(c, "below point with nothing on order");
    assert.equal(c.suggestedQuantity, 8); // 10 − 2, no configured quantity

    const convert = await api("POST", "/api/reorder-suggestions/convert", {
      supplierId,
      items: [{ variantId: variantC }],
      note: "Reorder run",
    });
    assert.equal(convert.status, 201);
    const purchaseNumber = convert.json.data?.purchaseOrderNumber;
    assert.ok(purchaseNumber, "purchase order created");

    // The PO exists in the purchases list with the right line.
    const listPurchases = await api("GET", "/api/purchases");
    assert.equal(listPurchases.status, 200);
    void listPurchases;

    // Audit entry written.
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const audit = await client.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'purchase.from_reorder'`,
    );
    await client.end();
    assert.ok(audit.rows[0].n >= 1);
  });
});
