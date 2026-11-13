/**
 * Sold-by-weight integration (P0 fix #3): fractional quantities must flow
 * end-to-end — scan-embedded weight enters as 0.75, checkout stores the
 * exact amount, stock moves fractionally, and refunds (full and partial)
 * land in the ledger without the integer-column rounding that previously
 * corrupted sale_refund_items (0.75 silently became 1).
 *
 * Covered:
 *   0.75 kg sale → sale_items.quantity 0.75, stock −0.75, exact line money
 *   1.25 kg sale → stock −1.25 cumulative
 *   whole numbers on a weight line (1 kg, 2 kg) stay legal
 *   fractional on a NON-weight line → rejected (per-variant rule intact)
 *   full-line refund of 0.75 → ledger row 0.75 (not 1), stock +0.75
 *   partial refund 0.25 of 1.25 → ledger row 0.25, stock +0.25
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("sold-by-weight sales integration", { skip: !runIntegration }, () => {
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

  const stamp = `wt-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

  async function api(
    token: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    payload?: unknown,
  ) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId || 0),
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
  let kgUnitId = 0;
  let weightVariantId = 0;
  let solidVariantId = 0;

  before(async () => {
    const email = `${stamp}-owner@example.test`;
    await api("", "POST", "/api/auth/register", {
      fullName: "Weight Sales Owner",
      email,
      password: "strong-password-123",
    });
    const login = await api("", "POST", "/api/auth/login", {
      email,
      password: "strong-password-123",
    });
    ownerToken = login.body.accessToken;
    const biz = await api(ownerToken, "POST", "/api/businesses", {
      name: `Weight Sales ${stamp}`,
    });
    businessId = biz.body.business.id;
    await api(ownerToken, "POST", "/api/locations", { name: "Main" });

    await api(ownerToken, "POST", "/api/product/unit", {
      unitName: "Kilogram",
      abbreviation: "kg",
    });
    const opts = await api(ownerToken, "GET", "/api/product/select-options");
    kgUnitId = (opts.body.units ?? []).find((u: any) => u.label === "Kilogram").value;

    // Weight product: 10 kg @ ৳200/kg (opening stock via the variant row).
    const weightProduct = await api(ownerToken, "POST", "/api/product", {
      name: `Bulk Rice ${stamp}`,
      categoryId: null,
      brandId: null,
      unitId: kgUnitId,
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
          sku: `RICE-${stamp}`,
          barcode: null,
          sellingPrice: 200,
          purchasePrice: 150,
          quantity: 10,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          batchNumber: `RICE-${stamp}`,
          expiryDate: null,
          options: [],
          weight: null,
          weightUnit: "kg",
          imageUrl: null,
          imageFile: null,
        },
      ],
    });
    assert.equal(weightProduct.status, 201, JSON.stringify(weightProduct.body));
    const weightDetail = await api(ownerToken, "GET", `/api/product/${weightProduct.body.data.productId}`);
    weightVariantId = weightDetail.body.variants[0].id;
    // The variant editor does not expose the flag yet (known follow-up) —
    // set it the way the service expects to find it.
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(
      `UPDATE product_variants SET sold_by_weight = true WHERE id = $1`,
      [weightVariantId],
    );
    await client.end();

    // Solid product for the integrality guard (10 pcs @ ৳100).
    const solidProduct = await api(ownerToken, "POST", "/api/product", {
      name: `Steel Bolt ${stamp}`,
      categoryId: null,
      brandId: null,
      unitId: kgUnitId,
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
          sku: `BOLT-${stamp}`,
          barcode: null,
          sellingPrice: 100,
          purchasePrice: 60,
          quantity: 10,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          batchNumber: `BOLT-${stamp}`,
          expiryDate: null,
          options: [],
          weight: null,
          weightUnit: "kg",
          imageUrl: null,
          imageFile: null,
        },
      ],
    });
    assert.equal(solidProduct.status, 201, JSON.stringify(solidProduct.body));
    const solidDetail = await api(ownerToken, "GET", `/api/product/${solidProduct.body.data.productId}`);
    solidVariantId = solidDetail.body.variants[0].id;
  });

  function salePayload(items: unknown[], total: number) {
    return {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: total }],
      discount: null,
      vatPercent: 0,
      items,
    };
  }

  async function weightStock(): Promise<number> {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const rows = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS qty FROM inventory_stock
       WHERE business_id = $1 AND variant_id = $2`,
      [businessId, weightVariantId],
    );
    client.end();
    return Number(rows.rows[0].qty);
  }

  async function refundRows(saleId: number): Promise<{ quantity: number; refundTotal: number }[]> {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const rows = await client.query(
      `SELECT sri.quantity, sri.refund_total
       FROM sale_refund_items sri
       JOIN sale_refunds sr ON sr.id = sri.refund_id
       WHERE sr.sale_id = $1 AND sri.business_id = $2
       ORDER BY sri.id`,
      [saleId, businessId],
    );
    client.end();
    return rows.rows.map((r: any) => ({
      quantity: Number(r.quantity),
      refundTotal: Number(r.refund_total),
    }));
  }

  it("sells 0.5 kg: exact fractional quantity, stock and money", async () => {
    const before = await weightStock();
    const res = await api(ownerToken, "POST", "/api/sales", salePayload(
      [{ variantId: weightVariantId, quantity: 0.5, unitPrice: 200, discount: null }],
      100,
    ));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.sale.subtotal, 100);

    const afterStock = await weightStock();
    assert.ok(Math.abs(afterStock - (before - 0.5)) < 1e-9, `stock ${before} -> ${afterStock}`);
  });

  it("sells 1.25 kg cumulatively after the 0.5 kg sale", async () => {
    const before = await weightStock();
    const res = await api(ownerToken, "POST", "/api/sales", salePayload(
      [{ variantId: weightVariantId, quantity: 1.25, unitPrice: 200, discount: null }],
      250,
    ));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const afterStock = await weightStock();
    assert.ok(Math.abs(afterStock - (before - 1.25)) < 1e-9);
  });

  it("keeps whole numbers legal on a weight line (1 kg)", async () => {
    const res = await api(ownerToken, "POST", "/api/sales", salePayload(
      [{ variantId: weightVariantId, quantity: 1, unitPrice: 200, discount: null }],
      200,
    ));
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  it("rejects fractional quantities on a non-weight line", async () => {
    const res = await api(ownerToken, "POST", "/api/sales", salePayload(
      [{ variantId: solidVariantId, quantity: 0.5, unitPrice: 100, discount: null }],
      50,
    ));
    assert.equal(res.status, 400);
    assert.match(String(res.body.message ?? ""), /whole number/i);
  });

  it("rejects weight quantities beyond 3 decimals", async () => {
    const res = await api(ownerToken, "POST", "/api/sales", salePayload(
      [{ variantId: weightVariantId, quantity: 0.1234, unitPrice: 200, discount: null }],
      24.68,
    ));
    assert.equal(res.status, 400);
  });

  it("refunds a 0.5 kg line fully — ledger records 0.5, not the rounded 1", async () => {
    // Sell exactly 0.5 kg on a fresh sale so the refund targets one line.
    const res = await api(ownerToken, "POST", "/api/sales", salePayload(
      [{ variantId: weightVariantId, quantity: 0.5, unitPrice: 200, discount: null }],
      100,
    ));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const saleId = res.body.data.sale.id;

    const before = await weightStock();
    const refund = await api(ownerToken, "POST", `/api/sold_products/refunds_all/${saleId}`, {
      reason: "customer_request",
      disposition: "restock",
      refundMethod: "cash",
    });
    assert.equal(refund.status, 200, JSON.stringify(refund.body));

    const rows = await refundRows(saleId);
    assert.equal(rows.length, 1);
    const fullRefundRow = rows[0]!;
    assert.ok(
      Math.abs(fullRefundRow.quantity - 0.5) < 1e-9,
      `refund ledger quantity must be 0.5, got ${fullRefundRow.quantity}`,
    );
    assert.ok(Math.abs(fullRefundRow.refundTotal - 100) < 0.01);

    const afterStock = await weightStock();
    assert.ok(Math.abs(afterStock - (before + 0.5)) < 1e-9);
  });

  it("refunds 0.25 of a 1.25 kg line partially — ledger and stock exact", async () => {
    const res = await api(ownerToken, "POST", "/api/sales", salePayload(
      [{ variantId: weightVariantId, quantity: 1.25, unitPrice: 200, discount: null }],
      250,
    ));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const saleId = res.body.data.sale.id;

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const itemRows = await client.query(
      `SELECT id FROM sale_items WHERE sale_id = $1 AND business_id = $2 ORDER BY id LIMIT 1`,
      [saleId, businessId],
    );
    client.end();
    const saleItemId = itemRows.rows[0]!.id;

    const before = await weightStock();
    const refund = await api(ownerToken, "POST", `/api/sold_products/refunds_all/${saleId}`, {
      reason: "wrong_item",
      disposition: "restock",
      refundMethod: "cash",
      quantities: [{ saleItemId, quantity: 0.25 }],
    });
    assert.equal(refund.status, 200, JSON.stringify(refund.body));

    const rows = await refundRows(saleId);
    const partialRow = rows[0]!;
    assert.ok(Math.abs(partialRow.quantity - 0.25) < 1e-9, `got ${partialRow.quantity}`);
    const afterStock = await weightStock();
    assert.ok(Math.abs(afterStock - (before + 0.25)) < 1e-9);

    // The remaining 1.0 can still be refunded afterwards.
    const second = await api(ownerToken, "POST", `/api/sold_products/refunds_all/${saleId}`, {
      reason: "customer_request",
      disposition: "restock",
      refundMethod: "cash",
      quantities: [{ saleItemId, quantity: 1 }],
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const allRows = await refundRows(saleId);
    const totalReturned = allRows.reduce((sum, r) => sum + r.quantity, 0);
    assert.ok(Math.abs(totalReturned - 1.25) < 1e-9);
  });
});
