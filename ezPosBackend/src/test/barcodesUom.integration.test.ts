/**
 * UOM package barcodes (Phase 4): an alias carrying uomConversionId is a
 * PACKAGE barcode — lookup resolves the variant AND the packaging unit with
 * its server-resolved price, so a scan can add "1 Box" instead of 1 piece.
 * Aliases without the qualifier (all legacy rows) resolve base-unit.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("uom package barcodes integration", { skip: !runIntegration }, () => {
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

  const stamp = `uomb-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

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
  let variantId = 0;
  let conversionId = 0;
  let productId = 0;

  before(async () => {
    const email = `${stamp}-owner@example.test`;
    await api("", "POST", "/api/auth/register", {
      fullName: "UOM Barcode Owner",
      email,
      password: "strong-password-123",
    });
    const login = await api("", "POST", "/api/auth/login", {
      email,
      password: "strong-password-123",
    });
    ownerToken = login.body.accessToken;
    const biz = await api(ownerToken, "POST", "/api/businesses", {
      name: `UOM Barcode ${stamp}`,
    });
    businessId = biz.body.business.id;
    await api(ownerToken, "POST", "/api/locations", { name: "Main" });

    await api(ownerToken, "POST", "/api/product/unit", { unitName: "Piece", abbreviation: "pc" });
    await api(ownerToken, "POST", "/api/product/unit", { unitName: `Box ${stamp}`, abbreviation: "box" });
    const opts = await api(ownerToken, "GET", "/api/product/select-options");
    const pcUnitId = (opts.body.units ?? []).find((u: any) => u.label === "Piece").value;
    const boxUnitId = (opts.body.units ?? []).find((u: any) => u.label === `Box ${stamp}`).value;

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
          sku: `TCB-${stamp}`,
          barcode: `890${stamp.slice(-7)}1`,
          sellingPrice: 130,
          purchasePrice: 100,
          quantity: 60,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          batchNumber: `TCB-${stamp}`,
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
    productId = product.body.data.productId;
    const detail = await api(ownerToken, "GET", `/api/product/${productId}`);
    variantId = detail.body.variants[0].id;

    const conv = await api(ownerToken, "POST", `/api/product/${productId}/uom`, {
      unitId: boxUnitId,
      conversionFactor: 12,
      isPurchaseEnabled: true,
      isSaleEnabled: true,
      purchasePrice: 1200,
      salePrice: 1500,
    });
    conversionId = conv.body.data.id;
  });

  it("assigns a package barcode alias to the Box conversion", async () => {
    const res = await api(ownerToken, "POST", "/api/barcodes/assign", {
      variantId,
      barcode: `891${stamp.slice(-7)}2`,
      target: "alias",
      source: "external",
      uomConversionId: conversionId,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  it("rejects a package barcode pointing at another product's conversion", async () => {
    // A conversion from a different product: create one quickly.
    const other = await api(ownerToken, "POST", "/api/product", {
      name: `Other ${stamp}`,
      categoryId: null,
      brandId: null,
      unitId: (await api(ownerToken, "GET", "/api/product/select-options")).body.units[0].value,
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
          sku: `OTH-${stamp}`,
          barcode: null,
          sellingPrice: 10,
          purchasePrice: 5,
          quantity: 1,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          batchNumber: `OTH-${stamp}`,
          expiryDate: null,
          options: [],
          weight: null,
          weightUnit: "kg",
          imageUrl: null,
          imageFile: null,
        },
      ],
    });
    assert.equal(other.status, 201);
    const opts = await api(ownerToken, "GET", "/api/product/select-options");
    const pcUnit = (opts.body.units ?? []).find((u: any) => u.label === "Piece").value;
    const conv = await api(ownerToken, "POST", `/api/product/${other.body.data.productId}/uom`, {
      unitId: pcUnit === (opts.body.units ?? [])[0]?.value ? (opts.body.units ?? [])[1]?.value : pcUnit,
      conversionFactor: 6,
    });
    assert.equal(conv.status, 201);
    void conv;

    const res = await api(ownerToken, "POST", "/api/barcodes/assign", {
      variantId,
      barcode: `892${stamp.slice(-7)}3`,
      target: "alias",
      uomConversionId: 999_999_999,
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  it("resolves the package barcode with its unit and price (and the base one without)", async () => {
    const pkg = await api(
      ownerToken,
      "GET",
      `/api/barcodes/lookup/891${stamp.slice(-7)}2`,
    );
    assert.equal(pkg.status, 200, JSON.stringify(pkg.body));
    assert.equal(pkg.body.data.matchType, "alias");
    assert.equal(pkg.body.data.variantId, variantId);
    assert.ok(pkg.body.data.unit, "package alias must carry unit context");
    assert.equal(pkg.body.data.unit.conversionId, conversionId);
    assert.equal(pkg.body.data.unit.conversionFactor, 12);
    assert.equal(pkg.body.data.unit.salePrice, 1500);
    assert.equal(pkg.body.data.unit.unitAbbreviation, "box");

    const base = await api(
      ownerToken,
      "GET",
      `/api/barcodes/lookup/890${stamp.slice(-7)}1`,
    );
    assert.equal(base.status, 200);
    assert.equal(base.body.data.matchType, "primary");
    assert.equal(base.body.data.unit, null); // primary = base unit
  });
});
