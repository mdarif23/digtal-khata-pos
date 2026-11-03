/**
 * Product & variant integration tests (audit gap: the addProduct/products
 * surface had no dedicated coverage): creation rules per tracking type,
 * auto SKU, opening-stock seeding, stock adjustment, tenant scoping —
 * against a REAL PostgreSQL database. Double-guarded like the other suites.
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

describe("products integration", { skip: !runIntegration }, () => {
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

  async function createUnit(ctx: OwnerCtx): Promise<number> {
    const { status, body } = await postJson(baseUrl, ctx, "/api/product/unit", {
      unitName: `Unit ${Date.now()}-${(counter += 1)}`,
      abbreviation: `u${Date.now() % 100000}-${(counter += 1)}`,
    });
    assert.equal(status, 201, `unit create failed: ${JSON.stringify(body)}`);
    const id = body?.data?.value ?? body?.data?.id ?? body?.id;
    assert.ok(id, "unit id missing from response");
    return Number(id);
  }

  async function getProduct(ctx: OwnerCtx, productId: number): Promise<any> {
    const { status, body } = await getJson(
      baseUrl,
      ctx,
      `/api/product/${productId}`,
    );
    assert.equal(status, 200, `product fetch failed: ${JSON.stringify(body)}`);
    return body?.data ?? body;
  }

  async function createProduct(
    ctx: OwnerCtx,
    unitId: number,
    overrides: {
      trackingType?: "none" | "batch" | "serial";
      source?: "opening" | "purchase";
      variant?: {
        sku?: string;
        sellingPrice?: number;
        quantity?: number;
        purchasePrice?: number;
        batchNumber?: string;
        serialNumbers?: string[];
      };
    } = {},
  ): Promise<{ productId: number; detail: any }> {
    const v = overrides.variant ?? {};
    const payload = {
      name: `Product ${Date.now()}-${(counter += 1)}`,
      categoryId: null,
      brandId: null,
      unitId,
      description: "",
      productType: "physical",
      hasVariants: false,
      trackingType: overrides.trackingType ?? "none",
      supplierId: null,
      status: "active",
      source: overrides.source ?? "opening",
      variants: [
        {
          sku: v.sku ?? "",
          barcode: "",
          sellingPrice: v.sellingPrice ?? 100,
          alertQuantity: 2,
          isDefault: true,
          status: "active",
          batchNumber: v.batchNumber ?? "",
          purchasePrice: v.purchasePrice ?? 40,
          quantity: v.quantity ?? 0,
          expiryDate: null,
          serialNumbers: (v.serialNumbers ?? []).map((serial) => ({ serial })),
          options: [],
        },
      ],
    };
    const { status, body } = await postJson(baseUrl, ctx, "/api/product", payload);
    assert.equal(
      status,
      201,
      `product create failed: ${JSON.stringify(body)}`,
    );
    const productId = body?.data?.productId;
    assert.ok(productId, "productId missing from response");
    const detail = await getProduct(ctx, Number(productId));
    return { productId: Number(productId), detail };
  }

  async function stockRow(businessId: number, variantId: number) {
    const { rows } = await pg!.query(
      "SELECT quantity FROM inventory_stock WHERE business_id = $1 AND variant_id = $2",
      [businessId, variantId],
    );
    return rows[0] as { quantity: number } | undefined;
  }

  it("creates a product with an auto SKU and seeds opening stock", async () => {
    const owner = await createOwnerCtx(baseUrl, "Products Auto Co");
    const unitId = await createUnit(owner);

    const { productId, detail } = await createProduct(owner, unitId, {
      variant: { quantity: 10, purchasePrice: 40, sellingPrice: 100 },
    });

    const variant = detail?.variants?.[0];
    assert.ok(variant, "variant missing from product detail");
    assert.match(String(variant.sku), /^SKU-\d{6}$/);

    const stock = await stockRow(owner.businessId, Number(variant.id));
    assert.equal(stock?.quantity, 10);
    assert.ok(productId > 0);
  });

  it("requires a batchNumber when batch tracking is on", async () => {
    const owner = await createOwnerCtx(baseUrl, "Products Batch Co");
    const unitId = await createUnit(owner);

    const { status } = await postJson(baseUrl, owner, "/api/product", {
      name: `Batch Product ${Date.now()}-${(counter += 1)}`,
      categoryId: null,
      brandId: null,
      unitId,
      description: "",
      productType: "physical",
      hasVariants: false,
      trackingType: "batch",
      supplierId: null,
      status: "active",
      source: "opening",
      variants: [
        {
          sku: "",
          barcode: "",
          sellingPrice: 100,
          alertQuantity: 2,
          isDefault: true,
          status: "active",
          batchNumber: "",
          purchasePrice: 40,
          quantity: 5,
          expiryDate: null,
          serialNumbers: [],
          options: [],
        },
      ],
    });
    assert.equal(status, 400);
  });

  it("requires serials to match the quantity for serial tracking", async () => {
    const owner = await createOwnerCtx(baseUrl, "Products Serial Co");
    const unitId = await createUnit(owner);

    const { status } = await postJson(baseUrl, owner, "/api/product", {
      name: `Serial Product ${Date.now()}-${(counter += 1)}`,
      categoryId: null,
      brandId: null,
      unitId,
      description: "",
      productType: "physical",
      hasVariants: false,
      trackingType: "serial",
      supplierId: null,
      status: "active",
      source: "opening",
      variants: [
        {
          sku: "",
          barcode: "",
          sellingPrice: 100,
          alertQuantity: 2,
          isDefault: true,
          status: "active",
          batchNumber: "",
          purchasePrice: 40,
          quantity: 2,
          expiryDate: null,
          serialNumbers: [{ serial: "SN-1" }],
          options: [],
        },
      ],
    });
    assert.equal(status, 400);
  });

  it("creates serial-tracked stock with the supplied serials", async () => {
    const owner = await createOwnerCtx(baseUrl, "Products Serials OK Co");
    const unitId = await createUnit(owner);

    const { detail } = await createProduct(owner, unitId, {
      trackingType: "serial",
      variant: {
        quantity: 2,
        purchasePrice: 40,
        sellingPrice: 100,
        serialNumbers: ["SN-A", "SN-B"],
      },
    });
    assert.equal(detail?.trackingType, "serial");
    const variant = detail?.variants?.[0];
    assert.ok(variant, "variant missing");

    const stock = await stockRow(owner.businessId, Number(variant.id));
    assert.equal(stock?.quantity, 2);
  });

  it("forces quantity to 0 for purchase-sourced products (no stock row)", async () => {
    const owner = await createOwnerCtx(baseUrl, "Products Purchase Co");
    const unitId = await createUnit(owner);

    const { detail } = await createProduct(owner, unitId, {
      source: "purchase",
      variant: { quantity: 9, purchasePrice: 40, sellingPrice: 100 },
    });
    const variant = detail?.variants?.[0];
    assert.ok(variant, "variant missing");

    const stock = await stockRow(owner.businessId, Number(variant.id));
    assert.ok(!stock || Number(stock.quantity) === 0);
  });

  it("adjust-stock sets the absolute quantity and reports the change", async () => {
    const owner = await createOwnerCtx(baseUrl, "Products Adjust Co");
    const unitId = await createUnit(owner);

    const { detail } = await createProduct(owner, unitId, {
      variant: { quantity: 5, purchasePrice: 40, sellingPrice: 100 },
    });
    const variantId = Number(detail?.variants?.[0]?.id);

    const { status, body } = await postJson(
      baseUrl,
      owner,
      `/api/products/variants/${variantId}/adjust-stock`,
      { newQuantity: 3, reason: "damaged" },
    );
    assert.equal(status, 200, `adjust failed: ${JSON.stringify(body)}`);
    assert.equal(body?.data?.previousQuantity, 5);
    assert.equal(body?.data?.quantity, 3);
    assert.equal(body?.data?.change, -2);

    const stock = await stockRow(owner.businessId, variantId);
    assert.equal(stock?.quantity, 3);
  });

  it("rejects adjusting a variant with no inventory record", async () => {
    const owner = await createOwnerCtx(baseUrl, "Products Adjust 404 Co");
    const unitId = await createUnit(owner);

    const { detail } = await createProduct(owner, unitId, {
      source: "purchase",
      variant: { quantity: 9, purchasePrice: 40, sellingPrice: 100 },
    });
    const variantId = Number(detail?.variants?.[0]?.id);

    const { status, body } = await postJson(
      baseUrl,
      owner,
      `/api/products/variants/${variantId}/adjust-stock`,
      { newQuantity: 1, reason: "count_correction" },
    );
    assert.equal(status, 404);
    assert.match(String(body?.message), /Inventory record not found/);
  });

  it("rejects invalid adjustment reasons", async () => {
    const owner = await createOwnerCtx(baseUrl, "Products Adjust Reason Co");
    const unitId = await createUnit(owner);

    const { detail } = await createProduct(owner, unitId, {
      variant: { quantity: 5, purchasePrice: 40, sellingPrice: 100 },
    });
    const variantId = Number(detail?.variants?.[0]?.id);

    const { status } = await postJson(
      baseUrl,
      owner,
      `/api/products/variants/${variantId}/adjust-stock`,
      { newQuantity: 3, reason: "because-i-said-so" },
    );
    assert.equal(status, 400);
  });

  it("never adjusts another business's variant", async () => {
    const owner = await createOwnerCtx(baseUrl, "Products Tenant A");
    const unitId = await createUnit(owner);
    const { detail } = await createProduct(owner, unitId, {
      variant: { quantity: 5, purchasePrice: 40, sellingPrice: 100 },
    });
    const variantId = Number(detail?.variants?.[0]?.id);

    const other = await createOwnerCtx(baseUrl, "Products Tenant B");
    const { status } = await postJson(
      baseUrl,
      other,
      `/api/products/variants/${variantId}/adjust-stock`,
      { newQuantity: 0, reason: "count_correction" },
    );
    assert.equal(status, 404);
  });
});
