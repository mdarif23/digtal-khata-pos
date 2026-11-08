/**
 * Multiple Units of Measure (UOM) — Phase 1 foundation integration tests.
 * Proves the zero-touch migration contract and the configuration surface:
 *  - a product with NO conversion rows resolves as identity (factor 1)
 *  - packaging CRUD: create/duplicate/base-unit/factor guards, defaults,
 *    deactivation, the factor lock once a transaction references the row
 *  - the resolve endpoint is server-authoritative (5 Box @ ৳1,200 = 60 pcs
 *    @ ৳100/pc) and enforces the whole-base invariant when asked
 *  - variant overrides take precedence over product-level packaging
 *  - sell-units/purchase-units pickers (prices, package availability)
 *  - cross-tenant isolation and the unit-delete guard
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("uom foundation integration", { skip: !runIntegration }, () => {
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

  const stamp = `uom-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

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
        ...(businessId ? { "X-Business-Id": String(businessId) } : {}),
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
  let productId = 0;
  let variantId = 0;
  let conversionId = 0;
  let variantProductId = 0;
  let vSmall = 0;
  let vMedium = 0;
  let overrideConversionId = 0;

  before(async () => {
    // Owner + business + a "Piece" unit (created with the business).
    const email = `${stamp}-owner@example.test`;
    const reg = await api("", "POST", "/api/auth/register", {
      fullName: "UOM Owner",
      email,
      password: "strong-password-123",
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const login = await api("", "POST", "/api/auth/login", {
      email,
      password: "strong-password-123",
    });
    ownerToken = login.body.accessToken;
    const biz = await api(ownerToken, "POST", "/api/businesses", {
      name: `UOM Biz ${stamp}`,
    });
    assert.equal(biz.status, 201, JSON.stringify(biz.body));
    businessId = biz.body.business.id;

    // A location is required before inventory can be recorded.
    const loc = await api(ownerToken, "POST", "/api/locations", {
      name: "UOM Store",
    });
    assert.equal(loc.status, 201, JSON.stringify(loc.body));

    // Create the base + packaging units, then read them back via
    // select-options (the shape the frontend uses).
    const pieceRes = await api(ownerToken, "POST", "/api/product/unit", {
      unitName: "Piece",
      abbreviation: "pc",
    });
    assert.equal(pieceRes.status, 201, JSON.stringify(pieceRes.body));
    const boxRes = await api(ownerToken, "POST", "/api/product/unit", {
      unitName: `Box ${stamp}`,
      abbreviation: "box",
    });
    assert.equal(boxRes.status, 201, JSON.stringify(boxRes.body));
    const opts = await api(ownerToken, "GET", "/api/product/select-options");
    pcUnitId = (opts.body.units ?? []).find((u: any) => u.label === "Piece").value;
    boxUnitId = (opts.body.units ?? []).find(
      (u: any) => u.label === `Box ${stamp}`,
    ).value;

    // Product with opening stock (60 pcs) so sell-units availability works.
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
          sku: `TC-${stamp}`,
          barcode: null,
          sellingPrice: 130,
          purchasePrice: 100,
          quantity: 60,
          alertQuantity: 5,
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
    productId = product.body.data.productId;
    const detail = await api(ownerToken, "GET", `/api/product/${productId}`);
    assert.equal(detail.status, 200);
    variantId = detail.body.variants[0].id;

    // A second product with real variants for override tests.
    const sizeType = await api(ownerToken, "POST", "/api/product/variant-type", {
      variantTypeName: `Size ${stamp}`,
    });
    assert.equal(sizeType.status, 201, JSON.stringify(sizeType.body));
    const sizeTypeId = sizeType.body.data?.id ?? sizeType.body.id;
    const sizeOptions = await api(
      ownerToken,
      "POST",
      "/api/product/variant-option",
      { variantTypeId: sizeTypeId, variantOptionName: ["Small", "Medium"] },
    );
    assert.equal(sizeOptions.status, 201, JSON.stringify(sizeOptions.body));
    const optionIds = (sizeOptions.body.data ?? sizeOptions.body).map(
      (o: { id: number }) => o.id,
    ) as number[];

    const product2 = await api(ownerToken, "POST", "/api/product", {
      name: `Football ${stamp}`,
      categoryId: null,
      brandId: null,
      unitId: pcUnitId,
      description: "",
      productType: "physical",
      hasVariants: true,
      trackingType: "none",
      supplierId: null,
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "opening",
      variants: [
        {
          sku: `FB-S-${stamp}`,
          barcode: null,
          sellingPrice: 200,
          purchasePrice: 150,
          quantity: 10,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          batchNumber: `FB-S-${stamp}`,
          expiryDate: null,
          options: [
            {
              typeId: sizeTypeId,
              typeName: `Size ${stamp}`,
              optionId: optionIds[0],
              value: "Small",
            },
          ],
          weight: null,
          weightUnit: "kg",
          imageUrl: null,
          imageFile: null,
        },
        {
          sku: `FB-M-${stamp}`,
          barcode: null,
          sellingPrice: 260,
          purchasePrice: 180,
          quantity: 10,
          alertQuantity: 0,
          isDefault: false,
          status: "active",
          batchNumber: `FB-M-${stamp}`,
          expiryDate: null,
          options: [
            {
              typeId: sizeTypeId,
              typeName: `Size ${stamp}`,
              optionId: optionIds[1],
              value: "Medium",
            },
          ],
          weight: null,
          weightUnit: "kg",
          imageUrl: null,
          imageFile: null,
        },
      ],
    });
    assert.equal(product2.status, 201, JSON.stringify(product2.body));
    variantProductId = product2.body.data.productId;
    const detail2 = await api(ownerToken, "GET", `/api/product/${variantProductId}`);
    assert.equal(detail2.status, 200);
    vSmall = detail2.body.variants.find((v: any) => v.sku === `FB-S-${stamp}`).id;
    vMedium = detail2.body.variants.find((v: any) => v.sku === `FB-M-${stamp}`).id;
  });

  it("starts with no packaging rows and resolves identity (zero-touch contract)", async () => {
    const cfg = await api(ownerToken, "GET", `/api/product/${productId}/uom`);
    assert.equal(cfg.status, 200);
    assert.equal(cfg.body.data.units.length, 0);
    assert.equal(cfg.body.data.baseUnit.id, pcUnitId);
  });

  it("creates a Box-of-12 packaging unit with a default sale flag", async () => {
    const res = await api(ownerToken, "POST", `/api/product/${productId}/uom`, {
      unitId: boxUnitId,
      conversionFactor: 12,
      isSaleEnabled: true,
      isPurchaseEnabled: true,
      isDefaultSale: true,
      salePrice: 1500,
      purchasePrice: 1200,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    conversionId = res.body.data.id;
    assert.equal(res.body.data.conversionFactor, 12);
    assert.equal(res.body.data.isDefaultSale, true);
    assert.equal(res.body.data.isLocked, false);
    // salePrice is explicitly configured → no derived hint
    assert.equal(res.body.data.derivedSalePrice, null);
  });

  it("rejects duplicate unit, base unit, non-positive factor, and foreign units", async () => {
    const dup = await api(ownerToken, "POST", `/api/product/${productId}/uom`, {
      unitId: boxUnitId,
      conversionFactor: 6,
    });
    assert.equal(dup.status, 409);

    const base = await api(ownerToken, "POST", `/api/product/${productId}/uom`, {
      unitId: pcUnitId,
      conversionFactor: 1,
    });
    assert.equal(base.status, 400);

    const zero = await api(ownerToken, "POST", `/api/product/${productId}/uom`, {
      unitId: boxUnitId,
      conversionFactor: 0,
    });
    assert.equal(zero.status, 400);

    // A unit belonging to another business must be rejected by the composite FK.
    const other = await api(ownerToken, "POST", `/api/product/${productId}/uom`, {
      unitId: 999_999_999,
      conversionFactor: 2,
    });
    assert.equal(other.status, 400);
  });

  it("resolves entered units server-authoritatively (5 Box @ ৳1,200 → 60 pcs @ ৳100)", async () => {
    const res = await api(ownerToken, "POST", "/api/uom/resolve", {
      items: [
        {
          variantId,
          uomConversionId: conversionId,
          enteredQuantity: 5,
          enteredUnitPrice: 1200,
        },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = res.body.data[0];
    assert.equal(row.baseQuantity, 60);
    assert.equal(row.baseUnitPrice, 100);
    assert.equal(row.conversionFactor, 12);
    assert.equal(row.lineTotal, 6000);
    assert.equal(row.baseUnit.name, "Piece");
    assert.equal(row.enteredUnit.name, `Box ${stamp}`);
  });

  it("derives default sale prices (factor × variant price) for null sale_price", async () => {
    const res = await api(ownerToken, "POST", `/api/product/${variantProductId}/uom`, {
      unitId: boxUnitId,
      conversionFactor: 10,
      isSaleEnabled: true,
    });
    assert.equal(res.status, 201);
    const derived = res.body.data.derivedSalePrice;
    assert.equal(derived, 2000); // 10 × 200 (default variant)

    // resolve endpoint uses the derived price for POS display
    const r = await api(ownerToken, "POST", "/api/uom/resolve", {
      items: [{ variantId: vSmall, uomConversionId: res.body.data.id, enteredQuantity: 1 }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.data[0].defaultSalePrice, 2000);
    overrideConversionId = res.body.data.id;
  });

  it("variant overrides take precedence over product-level packaging", async () => {
    // Variant-specific Box factor 6 for Small only.
    const res = await api(ownerToken, "POST", `/api/product/${variantProductId}/uom`, {
      variantId: vSmall,
      unitId: boxUnitId,
      conversionFactor: 6,
      isSaleEnabled: true,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    // Same unit at product level would collide at the SMALL scope only if
    // duplicated — product-level row exists, so Small override coexists.
    const smallResolve = await api(ownerToken, "POST", "/api/uom/resolve", {
      items: [{ variantId: vSmall, uomConversionId: res.body.data.id, enteredQuantity: 2 }],
    });
    assert.equal(smallResolve.status, 200);
    assert.equal(smallResolve.body.data[0].baseQuantity, 12);

    // Medium cannot use the Small-scoped override.
    const mediumUse = await api(ownerToken, "POST", "/api/uom/resolve", {
      items: [{ variantId: vMedium, uomConversionId: res.body.data.id, enteredQuantity: 1 }],
    });
    assert.equal(mediumUse.status, 400);

    // Medium CAN use the product-level packaging (10/box).
    const mediumProductLevel = await api(ownerToken, "POST", "/api/uom/resolve", {
      items: [{ variantId: vMedium, uomConversionId: overrideConversionId, enteredQuantity: 1 }],
    });
    assert.equal(mediumProductLevel.status, 200);
    assert.equal(mediumProductLevel.body.data[0].baseQuantity, 10);
  });

  it("sell-units returns base + packaging with prices and package availability", async () => {
    const res = await api(ownerToken, "GET", `/api/variant/${variantId}/sell-units`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const units = res.body.data.units;
    assert.equal(units.length, 2);
    const base = units.find((u: any) => u.uomConversionId === null);
    const box = units.find((u: any) => u.uomConversionId === conversionId);
    assert.equal(base.salePrice, 130);
    assert.equal(base.isDefaultSale, false); // box is the configured default
    assert.equal(box.salePrice, 1500);
    assert.equal(box.conversionFactor, 12);
    assert.equal(box.availablePackages, 5); // floor(60/12)
    assert.equal(base.availablePackages, 60);
    assert.equal(res.body.data.baseUnit.name, "Piece");
  });

  it("purchase-units returns purchase-enabled units with default costs", async () => {
    const res = await api(ownerToken, "GET", `/api/variant/${variantId}/purchase-units`);
    assert.equal(res.status, 200);
    const units = res.body.data.units;
    const box = units.find((u: any) => u.uomConversionId === conversionId);
    assert.equal(box.defaultPurchasePrice, 1200);
    assert.equal(box.conversionFactor, 12);
  });

  it("enforces the whole-base invariant only when requested", async () => {
    const ok = await api(ownerToken, "POST", "/api/uom/resolve", {
      items: [{ variantId, uomConversionId: conversionId, enteredQuantity: 1.5 }],
      wholeBase: true,
    });
    assert.equal(ok.status, 200); // 1.5 × 12 = 18 (whole)

    // Identity 1.5 × 1 = 1.5 pcs — not a whole base quantity.
    const bad = await api(ownerToken, "POST", "/api/uom/resolve", {
      items: [{ variantId, uomConversionId: null, enteredQuantity: 1.5 }],
      wholeBase: true,
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /whole number/);
  });

  it("locks the factor once a transaction references the conversion", async () => {
    // A legacy (base-unit) purchase line, then point it at the conversion —
    // exactly the shape a Phase 2 UOM purchase writes.
    const purchase = await api(ownerToken, "POST", "/api/purchases", {
      supplierId: null,
      purchaseDate: new Date().toISOString(),
      notes: "uom factor-lock test",
      discount: 0,
      tax: 0,
      shippingCost: 0,
      items: [
        { variantId, quantity: 2, purchasePrice: 100, discount: 0, tax: 0 },
      ],
    });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.body));

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const upd = await client.query(
      `UPDATE purchase_items SET uom_conversion_id = $1, conversion_factor = 12,
         entered_quantity = 1, entered_unit_price = 1200
       WHERE business_id = $2
         AND variant_id = $3
         AND uom_conversion_id IS NULL
       RETURNING id`,
      [conversionId, businessId, variantId],
    );
    client.end();
    assert.ok(upd.rowCount && upd.rowCount > 0, "expected a purchase line to exist");

    const locked = await api(ownerToken, "PATCH", `/api/product/uom/${conversionId}`, {
      conversionFactor: 24,
    });
    assert.equal(locked.status, 409, JSON.stringify(locked.body));

    // Flags/prices stay editable on a locked row.
    const flags = await api(ownerToken, "PATCH", `/api/product/uom/${conversionId}`, {
      salePrice: 1550,
    });
    assert.equal(flags.status, 200);
    assert.equal(flags.body.data.salePrice, 1550);
  });

  it("deactivates safely and rejects inactive rows for new documents", async () => {
    // Deactivation needs a row without references: use the Small override.
    const dec = await api(
      ownerToken,
      "POST",
      `/api/product/uom/${overrideConversionId}/deactivate`,
    );
    assert.equal(dec.status, 200);
    assert.equal(dec.body.data.status, "inactive");
    assert.equal(dec.body.data.isDefaultSale, false);

    const use = await api(ownerToken, "POST", "/api/uom/resolve", {
      items: [{ variantId: vSmall, uomConversionId: overrideConversionId, enteredQuantity: 1 }],
    });
    assert.equal(use.status, 400);

    // ...but a HISTORY read (requireActive: false) still resolves it —
    // exercised via the config list, which includes inactive rows.
    const cfg = await api(ownerToken, "GET", `/api/product/${variantProductId}/uom`);
    const inactive = cfg.body.data.units.find((u: any) => u.id === overrideConversionId);
    assert.ok(inactive);
    assert.equal(inactive.status, "inactive");
  });

  it("keeps conversion config tenant-isolated", async () => {
    // A second business sees nothing of the first business's packaging.
    const email = `${stamp}-other@example.test`;
    await api("", "POST", "/api/auth/register", {
      fullName: "Other Owner",
      email,
      password: "strong-password-123",
    });
    const login = await api("", "POST", "/api/auth/login", {
      email,
      password: "strong-password-123",
    });
    const otherToken = login.body.accessToken;
    await api(otherToken, "POST", "/api/businesses", { name: `Other ${stamp}` });

    const cfg = await api(otherToken, "GET", `/api/product/${productId}/uom`);
    assert.equal(cfg.status, 403); // product access is tenant-scoped

    const resolve = await api(otherToken, "POST", "/api/uom/resolve", {
      items: [{ variantId, uomConversionId: conversionId, enteredQuantity: 1 }],
    });
    assert.ok(resolve.status >= 400); // foreign variant/conversion never resolves
    assert.ok(resolve.status !== 500); // and never leaks a server error
  });

  it("guards unit deletion while a packaging configuration references it", async () => {
    const res = await api(ownerToken, "DELETE", `/api/product/unit/${boxUnitId}`);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.message, /packaging/i);
  });
});
