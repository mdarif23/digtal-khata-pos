/**
 * UOM sales integration (Phase 3): the master-prompt §7 worked example.
 * Available: 60 pcs. 1 Box = 12 pcs @ ৳1,500/box; piece @ ৳130.
 *
 *   Sale 1: 1 Box   → −12 pcs, lineTotal ৳1,500, COGS 12 × per-base cost
 *   Sale 2: 3 pcs   → −3 pcs, lineTotal ৳390
 *   Combined cart (Box + Piece lines of the SAME variant) → −15 pcs
 *   6 Box against 60 pcs → rejected (72 > 60)
 *   Quote endpoint matches the checkout total for the same cart
 *   Held cart keeps the entered unit and resumes into a UOM checkout
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("uom sales integration", { skip: !runIntegration }, () => {
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

  const stamp = `uoms-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

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
      fullName: "UOM Sales Owner",
      email,
      password: "strong-password-123",
    });
    const login = await api("", "POST", "/api/auth/login", {
      email,
      password: "strong-password-123",
    });
    ownerToken = login.body.accessToken;
    const biz = await api(ownerToken, "POST", "/api/businesses", {
      name: `UOM Sales ${stamp}`,
    });
    businessId = biz.body.business.id;
    await api(ownerToken, "POST", "/api/locations", { name: "Main" });

    await api(ownerToken, "POST", "/api/product/unit", { unitName: "Piece", abbreviation: "pc" });
    await api(ownerToken, "POST", "/api/product/unit", { unitName: `Box ${stamp}`, abbreviation: "box" });
    const opts = await api(ownerToken, "GET", "/api/product/select-options");
    pcUnitId = (opts.body.units ?? []).find((u: any) => u.label === "Piece").value;
    boxUnitId = (opts.body.units ?? []).find((u: any) => u.label === `Box ${stamp}`).value;

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
          sku: `TCS-${stamp}`,
          barcode: null,
          sellingPrice: 130,
          purchasePrice: 100,
          quantity: 60,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          batchNumber: `TCS-${stamp}`,
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
    conversionId = conv.body.data.id;
  });

  function salePayload(items: unknown[], total: number, extra: Record<string, unknown> = {}) {
    return {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: total }],
      discount: null,
      vatPercent: 0,
      items,
      ...extra,
    };
  }

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

  it("sells 1 Box: −12 base stock, exact line money, snapshots intact", async () => {
    const before = await baseStock();
    const res = await api(ownerToken, "POST", "/api/sales", salePayload(
      [
        {
          variantId,
          quantity: 1,
          unitPrice: 1500,
          discount: null,
          uomConversionId: conversionId,
        },
      ],
      1500,
      { idempotencyKey: `${stamp}-box-1` },
    ));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const saleId = res.body.data.sale.id;

    assert.equal(await baseStock(), before - 12);

    const detail = await api(ownerToken, "GET", `/api/sales/${saleId}/receipt`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const line = detail.body.items[0];
    assert.equal(Number(line.quantity), 12); // base units
    assert.equal(Number(line.unitPrice), 125); // 1500 / 12 per base
    assert.equal(Number(line.lineTotal), 1500); // exact
    assert.equal(Number(line.enteredQuantity), 1);
    assert.equal(Number(line.enteredUnitPrice), 1500);
    assert.equal(Number(line.conversionFactor), 12);
    assert.equal(line.enteredUnitAbbreviation, "box");
    // COGS: FIFO at the opening batch's 100/pc landed cost → 12 × 100
    // (cost is permission-gated off the receipt, so read the snapshot).
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const costRow = await c.query(
      `SELECT cost_at_sale FROM sale_items WHERE id = $1`,
      [line.id],
    );
    c.end();
    assert.equal(Number(costRow.rows[0].cost_at_sale), 100);
  });

  it("sells 3 pieces from the same stock pool", async () => {
    const before = await baseStock();
    const res = await api(ownerToken, "POST", "/api/sales", salePayload(
      [{ variantId, quantity: 3, unitPrice: 130, discount: null }],
      390,
      { idempotencyKey: `${stamp}-pcs-3` },
    ));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await baseStock(), before - 3);
    const line = (await api(ownerToken, "GET", `/api/sales/${res.body.data.sale.id}/receipt`)).body.items[0];
    assert.equal(Number(line.quantity), 3);
    assert.equal(Number(line.lineTotal), 390);
    assert.equal(line.enteredQuantity, null); // legacy identity line
  });

  it("sells a mixed cart (Box + Piece of the same variant) and deducts 15", async () => {
    const before = await baseStock();
    const res = await api(ownerToken, "POST", "/api/sales", salePayload(
      [
        { variantId, quantity: 1, unitPrice: 1500, discount: null, uomConversionId: conversionId },
        { variantId, quantity: 3, unitPrice: 130, discount: null },
      ],
      1890,
      { idempotencyKey: `${stamp}-mixed-1` },
    ));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await baseStock(), before - 15);
    assert.equal(res.body.data.sale.finalTotal, 1890);
  });

  it("rejects selling 6 Box when only 60 pieces remain", async () => {
    const stock = await baseStock();
    const boxes = Math.floor(stock / 12) + 1; // one more than available
    const res = await api(ownerToken, "POST", "/api/sales", salePayload(
      [
        {
          variantId,
          quantity: boxes,
          unitPrice: 1500,
          discount: null,
          uomConversionId: conversionId,
        },
      ],
      boxes * 1500,
      { idempotencyKey: `${stamp}-over-${boxes}` },
    ));
    assert.ok(res.status >= 400, JSON.stringify(res.body));
    assert.match(res.body.message, /Insufficient stock/);
  });

  it("rejects a UOM line that does not convert to whole base units", async () => {
    // A decimal factor variant: 1 Half = 0.5? Instead use 1 Box with a
    // fractional entered quantity 0.5 → 6 pcs (whole, legal); 0.1 → 1.2
    // (not whole) must be rejected.
    const res = await api(ownerToken, "POST", "/api/sales", salePayload(
      [
        {
          variantId,
          quantity: 0.1,
          unitPrice: 1500,
          discount: null,
          uomConversionId: conversionId,
        },
      ],
      150,
      { idempotencyKey: `${stamp}-frac` },
    ));
    assert.ok(res.status >= 400, JSON.stringify(res.body));
    assert.match(res.body.message, /whole number/);
  });

  it("quotes the same cart identically to checkout", async () => {
    const res = await api(ownerToken, "POST", "/api/sales/quote", {
      items: [
        { variantId, quantity: 1, uomConversionId: conversionId },
        { variantId, quantity: 3 },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.finalTotal, 1890);
  });

  it("holds a UOM cart and returns the entered unit on resume", async () => {
    const hold = await api(ownerToken, "POST", "/api/held-sales", {
      name: `UOM hold ${stamp}`,
      items: [
        {
          variantId,
          quantity: 2,
          productName: `Toy Car ${stamp}`,
          uomConversionId: conversionId,
        },
      ],
    });
    assert.equal(hold.status, 201, JSON.stringify(hold.body));
    const holdId = hold.body.data.id;

    const list = await api(ownerToken, "GET", "/api/held-sales");
    const row = list.body.data.find((h: any) => h.id === holdId);
    assert.ok(row);
    const line = row.items[0];
    assert.equal(line.quantity, 2);
    assert.equal(line.uomConversionId, conversionId);
    assert.equal(line.enteredQuantity, 2);

    // Resume = the register rebuilds the checkout payload from the hold;
    // the checkout must accept it and deduct 24 base units.
    const before = await baseStock();
    const res = await api(ownerToken, "POST", "/api/sales", salePayload(
      [
        {
          variantId,
          quantity: line.quantity,
          unitPrice: 1500,
          discount: null,
          uomConversionId: line.uomConversionId,
        },
      ],
      3000,
      { idempotencyKey: `${stamp}-hold-resume` },
    ));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await baseStock(), before - 24);
    await api(ownerToken, "DELETE", `/api/held-sales/${holdId}`);
  });
});
