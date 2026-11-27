/**
 * Bundle & Combo Phase 5 — hardening: the master prompt's five end-to-end
 * scenarios, the composite-refund stock fix (F1), and bundle concurrency.
 *
 * Double-guarded: runs ONLY with INTEGRATION_TESTS=1 AND DATABASE_URL
 * pointing at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("bundle E2E scenarios + hardening (phase 5)", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let pgClient: import("pg").Client | null = null;

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
    pgClient = client;
    await ensureRbacSeed();
    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server?.close();
    await pgClient?.end();
  });

  const stamp = Date.now();

  interface Ctx {
    token: string;
    businessId: number;
    userId: number;
    email: string;
  }

  async function api(
    ctx: Ctx,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.token}`,
        "X-Business-Id": String(ctx.businessId),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  function payload<T>(res: { body: unknown }): T {
    return res.body as T;
  }

  async function dbQuery(sql: string, params: unknown[] = []): Promise<any[]> {
    return (await pgClient!.query(sql, params)).rows;
  }

  let owner: Ctx;
  let locationId = 0;
  let unitId = 0;
  let variantA = 0; // sells ৳100, costs ৳50
  let variantB = 0; // sells ৳30, costs ৳15
  let variantC = 0; // sells ৳20, costs ৳10
  let variantD = 0; // sells ৳10, costs ৳5
  let parentVariant = 0; // assemble-on-sale composite (BOM: 1×A + 2×B)

  async function makeVariant(
    name: string,
    sku: string,
    price: number,
  ): Promise<number> {
    const product = await api(owner, "POST", "/api/product", {
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
          sku,
          barcode: null,
          sellingPrice: price,
          alertQuantity: 5,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `P5-${sku}`,
          purchasePrice: Math.floor(price / 2),
          quantity: 500,
          expiryDate: null,
        },
      ],
    });
    assert.equal(product.status, 201, JSON.stringify(product.body));
    const list = await api(owner, "GET", "/api/products");
    const created = (
      list.body as { name: string; variants: { id: number }[] }[]
    ).find((p) => p.name === name);
    assert.ok(created);
    return created.variants[0]!.id;
  }

  async function stockOf(variantId: number): Promise<number> {
    const rows = await dbQuery(
      `SELECT quantity FROM inventory_stock WHERE business_id = $1 AND variant_id = $2 AND location_id = $3`,
      [owner.businessId, variantId, locationId],
    );
    return rows.length === 0 ? 0 : Number(rows[0]!.quantity);
  }

  before(async () => {
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "P5 Test",
        email: `p5-owner-${stamp}@example.test`,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `p5-owner-${stamp}@example.test`,
        password: "strong-password-123",
      }),
    });
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as {
      accessToken: string;
      user: { id: number };
    };
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginBody.accessToken}`,
      },
      body: JSON.stringify({ name: `P5 Biz ${stamp}` }),
    });
    assert.equal(biz.status, 201);
    owner = {
      token: loginBody.accessToken,
      businessId: (await biz.json() as { business: { id: number } }).business.id,
      userId: loginBody.user.id,
      email: `p5-owner-${stamp}@example.test`,
    };

    const loc = await api(owner, "POST", "/api/locations", {
      name: `P5 Main ${stamp}`,
    });
    locationId = payload<{ data: { id: number } }>(loc).data.id;

    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Pcs ${stamp}`,
      abbreviation: "Pcs",
    });
    unitId = payload<{ data: { value: number } }>(unitRes).data.value;
    variantA = await makeVariant(`P5 Notebook ${stamp}`, `P5A-${stamp}`, 100);
    variantB = await makeVariant(`P5 Pen ${stamp}`, `P5B-${stamp}`, 30);
    variantC = await makeVariant(`P5 Pencil ${stamp}`, `P5C-${stamp}`, 20);
    variantD = await makeVariant(`P5 Eraser ${stamp}`, `P5D-${stamp}`, 10);
    parentVariant = await makeVariant(`P5 Combo Pack ${stamp}`, `P5P-${stamp}`, 200);
    // The composite parent is assemble-on-sale: it holds no real stock.
    await dbQuery(
      `UPDATE inventory_stock SET quantity = 0 WHERE business_id = $1 AND variant_id = $2 AND location_id = $3`,
      [owner.businessId, parentVariant, locationId],
    );
    const bom = await api(owner, "PUT", `/api/variants/${parentVariant}/bom`, {
      components: [
        { componentVariantId: variantA, quantity: 1 },
        { componentVariantId: variantB, quantity: 2 },
      ],
    });
    assert.equal(bom.status, 200, JSON.stringify(bom.body));

    // Activate the finance ledger (opening-balance wizard, zero balances)
    // so sale/refund journal entries actually post for GL assertions.
    const activation = await api(owner, "POST", "/api/finance/activation", {
      accounts: [
        { name: "Cash drawer", type: "cash", openingBalance: 100 },
      ],
      ownerCapital: 0,
    });
    assert.equal(activation.status, 201, JSON.stringify(activation.body));
  });

  async function deactivateAllPromotions(): Promise<void> {
    await dbQuery(
      "UPDATE pricing_promotions SET is_active = false WHERE business_id = $1",
      [owner.businessId],
    );
  }

  async function createBundle(over: Record<string, unknown> = {}): Promise<number> {
    const res = await api(owner, "POST", "/api/promotions", {
      name: `P5 Pack ${stamp}`,
      discountType: "fixed",
      discountValue: 0,
      promoKind: "bundle",
      rule: { bundlePrice: 95 },
      isActive: true,
      components: [
        { variantId: variantA, quantity: 1 },
        { variantId: variantB, quantity: 2 },
      ],
      ...over,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return payload<{ data: { id: number } }>(res).data.id;
  }

  async function quote(items: Record<string, unknown>[]) {
    const res = await api(owner, "POST", "/api/sales/quote", {
      customerId: null,
      items,
      payments: [],
      discount: null,
      vatPercent: 0,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = payload<{ data: Record<string, unknown> }>(res).data;
    const promotions = data.promotions as
      | { applied: { id: number; name: string; amount: number }[]; total: number }
      | undefined;
    return {
      promotionsTotal: promotions?.total ?? 0,
      applied: promotions?.applied ?? [],
      finalTotal: Number(data.finalTotal),
    };
  }

  // --- F1: composite refund/void stock symmetry --------------------------------

  it("F1: voiding a composite sale restores component stock, never the parent", async () => {
    await deactivateAllPromotions();
    const beforeA = await stockOf(variantA);
    const beforeB = await stockOf(variantB);

    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 400, tendered: 400 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: parentVariant, quantity: 2, unitPrice: 200, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const saleData = payload<{ data: { sale: { id: number } } }>(sale).data.sale;

    // Sale consumed the COMPONENTS (2×A + 4×B); the parent is untouched.
    assert.equal(await stockOf(variantA), beforeA - 2);
    assert.equal(await stockOf(variantB), beforeB - 4);
    assert.equal(await stockOf(parentVariant), 0);

    const cancel = await api(owner, "POST", `/api/sales/${saleData.id}/cancel`, {
      reason: "F1 void test",
    });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));

    // Components back exactly; the parent still holds no stock.
    assert.equal(await stockOf(variantA), beforeA);
    assert.equal(await stockOf(variantB), beforeB);
    assert.equal(await stockOf(parentVariant), 0);
  });

  it("F1: partial refund of a composite sale restores component stock proportionally", async () => {
    await deactivateAllPromotions();
    const beforeA = await stockOf(variantA);
    const beforeB = await stockOf(variantB);

    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 400, tendered: 400 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: parentVariant, quantity: 2, unitPrice: 200, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const saleData = payload<{ data: { sale: { id: number } } }>(sale).data.sale;
    const itemRows = await dbQuery(
      `SELECT id FROM sale_items WHERE sale_id = $1`,
      [saleData.id],
    );

    const refund = await api(
      owner,
      "POST",
      `/api/sold_products/refunds_all/${saleData.id}`,
      {
        reason: "customer_request",
        disposition: "restock",
        refundMethod: "cash",
        quantities: [{ saleItemId: itemRows[0]!.id, quantity: 1 }],
      },
    );
    assert.equal(refund.status, 200, JSON.stringify(refund.body));
    // Half the composite line refunds half its value (no discounts here).
    const refundRow = await dbQuery(
      `SELECT refund_total FROM sale_refunds WHERE sale_id = $1 ORDER BY id DESC LIMIT 1`,
      [saleData.id],
    );
    assert.equal(Number(refundRow[0]!.refund_total), 200);

    // One composite unit's worth of components restored; parent untouched.
    assert.equal(await stockOf(variantA), beforeA - 1);
    assert.equal(await stockOf(variantB), beforeB - 2);
    assert.equal(await stockOf(parentVariant), 0);

    await api(owner, "POST", `/api/sales/${saleData.id}/cancel`, {
      reason: "F1 refund test cleanup",
    });
  });

  // --- Master prompt end-to-end scenarios ---------------------------------------

  it("Scenario 1: school package — special price, per-component stock, profit", async () => {
    await deactivateAllPromotions();
    await createBundle({
      name: `School Pack ${stamp}`,
      rule: { bundlePrice: 149 },
      components: [
        { variantId: variantA, quantity: 1 },
        { variantId: variantB, quantity: 2 },
        { variantId: variantC, quantity: 2 },
        { variantId: variantD, quantity: 1 },
      ],
    });
    const cart = [
      { variantId: variantA, quantity: 1, unitPrice: 100, discount: null },
      { variantId: variantB, quantity: 2, unitPrice: 30, discount: null },
      { variantId: variantC, quantity: 2, unitPrice: 20, discount: null },
      { variantId: variantD, quantity: 1, unitPrice: 10, discount: null },
    ];
    // Normal ৳210 → bundle ৳149.
    const q = await quote(cart);
    assert.equal(q.finalTotal, 149);

    const before = {
      a: await stockOf(variantA),
      b: await stockOf(variantB),
      c: await stockOf(variantC),
      d: await stockOf(variantD),
    };
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 149, tendered: 149 }],
      discount: null,
      vatPercent: 0,
      items: cart,
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const saleData = payload<{ data: { sale: { id: number; finalTotal: number } } }>(sale).data.sale;
    assert.equal(saleData.finalTotal, 149);

    // Component stock deducted, not bundle stock.
    assert.equal(await stockOf(variantA), before.a - 1);
    assert.equal(await stockOf(variantB), before.b - 2);
    assert.equal(await stockOf(variantC), before.c - 2);
    assert.equal(await stockOf(variantD), before.d - 1);

    // COGS from the components' own batches: 50 + 2×15 + 2×10 + 5 = ৳105.
    const costRows = await dbQuery(
      `SELECT COALESCE(SUM(cost_at_sale * quantity), 0) AS cogs FROM sale_items WHERE sale_id = $1`,
      [saleData.id],
    );
    assert.equal(Number(costRows[0]!.cogs), 105);
    // Gross profit = bundle price − component cost = ৳44 (never the bundle
    // price as cost, never the free-ish lines at zero cost).
    assert.equal(149 - Number(costRows[0]!.cogs), 44);
  });

  it("Scenario 2: buy 10 get 1 free — boundary, sale, inventory, accounting", async () => {
    await deactivateAllPromotions();
    const productIdA = (
      await dbQuery("SELECT product_id FROM product_variants WHERE id = $1", [variantA])
    )[0]!.product_id as number;
    const res = await api(owner, "POST", "/api/promotions", {
      name: `Buy10Get1 ${stamp}`,
      discountType: "fixed",
      discountValue: 0,
      promoKind: "buy_x_get_y",
      rule: {
        buyProductId: productIdA,
        buyQty: 10,
        getVariantId: variantA,
        getQty: 1,
        getDiscountPercent: 100,
      },
      isActive: true,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const q9 = await quote([{ variantId: variantA, quantity: 9, unitPrice: 100, discount: null }]);
    assert.equal(q9.promotionsTotal, 0); // 9 pens → no reward
    const q10 = await quote([{ variantId: variantA, quantity: 10, unitPrice: 100, discount: null }]);
    assert.equal(q10.promotionsTotal, 100); // the 10th unit is free

    const before = await stockOf(variantA);
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 900, tendered: 900 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: variantA, quantity: 10, unitPrice: 100, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const saleData = payload<{ data: { sale: { id: number; finalTotal: number } } }>(sale).data.sale;
    assert.equal(saleData.finalTotal, 900);
    assert.equal(await stockOf(variantA), before - 10);

    // Accounting: a posted journal entry for the sale exists.
    const gl = await dbQuery(
      `SELECT source_type, status FROM journal_entries WHERE business_id = $1 AND source_id = $2 AND source_type = 'sale'`,
      [owner.businessId, saleData.id],
    );
    assert.ok(gl.length >= 1, "sale journal entry posted");
    await deactivateAllPromotions();
  });

  it("Scenario 3: campaign window — before, during, after", async () => {
    await deactivateAllPromotions();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const campaign = await api(owner, "POST", "/api/campaigns", {
      name: `Window ${stamp}`,
      startsAt: tomorrow,
    });
    assert.equal(campaign.status, 201, JSON.stringify(campaign.body));
    const campaignId = payload<{ data: { id: number } }>(campaign).data.id;
    await createBundle({ name: `Window Pack ${stamp}`, campaignId });

    const cart = [
      { variantId: variantA, quantity: 1, unitPrice: 100, discount: null },
      { variantId: variantB, quantity: 2, unitPrice: 30, discount: null },
    ];
    // BEFORE the campaign: not applied.
    const before = await quote(cart);
    assert.equal(before.promotionsTotal, 0);

    // DURING: applied.
    const opened = await api(owner, "PATCH", `/api/campaigns/${campaignId}`, {
      startsAt: "2020-01-01",
    });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const during = await quote(cart);
    assert.equal(during.promotionsTotal, 65);
    assert.equal(during.finalTotal, 95);

    // AFTER expiration: not applied again.
    await api(owner, "PATCH", `/api/campaigns/${campaignId}`, { endsAt: "2020-01-02" });
    const after = await quote(cart);
    assert.equal(after.promotionsTotal, 0);
    await deactivateAllPromotions();
  });

  it("Scenario 4: combo partial return — refund, inventory, accounting reversal", async () => {
    await deactivateAllPromotions();
    await createBundle();
    const cart = [
      { variantId: variantA, quantity: 1, unitPrice: 100, discount: null },
      { variantId: variantB, quantity: 2, unitPrice: 30, discount: null },
    ];
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 95, tendered: 95 }],
      discount: null,
      vatPercent: 0,
      items: cart,
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const saleData = payload<{ data: { sale: { id: number } } }>(sale).data.sale;
    const items = await dbQuery(
      `SELECT id, variant_id FROM sale_items WHERE sale_id = $1`,
      [saleData.id],
    );
    const bRow = items.find((r) => r.variant_id === variantB)!;
    const beforeB = await stockOf(variantB);

    const refund = await api(owner, "POST", `/api/sold_products/refunds_all/${saleData.id}`, {
      reason: "customer_request",
      disposition: "restock",
      refundMethod: "cash",
      quantities: [
        { saleItemId: items.find((r) => r.variant_id === variantA)!.id, quantity: 0 },
        { saleItemId: bRow.id, quantity: 1 },
      ],
    });
    assert.equal(refund.status, 200, JSON.stringify(refund.body));

    // Pro-rata effective value (bundle discount included): pen line
    // 60 − 65×(60/160) = 35.63 → one of two units → 17.82.
    const refundRow = await dbQuery(
      `SELECT refund_total FROM sale_refunds WHERE sale_id = $1 ORDER BY id DESC LIMIT 1`,
      [saleData.id],
    );
    assert.equal(Number(refundRow[0]!.refund_total), 17.82);
    assert.equal(await stockOf(variantB), beforeB + 1);

    // Accounting: the refund posted its own journal entry.
    const gl = await dbQuery(
      `SELECT je.source_type FROM journal_entries je
       WHERE je.business_id = $1 AND je.source_type = 'sale_refund'
         AND je.source_id IN (SELECT id FROM sale_refunds WHERE sale_id = $2)`,
      [owner.businessId, saleData.id],
    );
    assert.ok(gl.length >= 1, "refund journal entry posted");
    await deactivateAllPromotions();
  });

  it("Scenario 5: overlapping promotions stack deterministically, never negative", async () => {
    await deactivateAllPromotions();
    await createBundle({ name: `Overlap Pack ${stamp}` });
    const discount = await api(owner, "POST", "/api/promotions", {
      name: `Overlap 10% ${stamp}`,
      discountType: "percentage",
      discountValue: 10,
      promoKind: "discount",
      priority: 5,
      isActive: true,
    });
    assert.equal(discount.status, 201, JSON.stringify(discount.body));

    const cart = [
      { variantId: variantA, quantity: 1, unitPrice: 100, discount: null },
      { variantId: variantB, quantity: 2, unitPrice: 30, discount: null },
    ];
    const q = await quote(cart);
    // Priority 5 discount first: 10% of 160 = 16. Then the bundle on the
    // post-group bases: 160 − 95 = 65. Both stack (promo-vs-promo stacking
    // is unconditional; group/coupon consent is the documented gate) — the
    // deterministic total is 81, never negative.
    assert.equal(q.promotionsTotal, 81);
    assert.equal(q.applied.length, 2);
    assert.equal(q.finalTotal, 79);
    await deactivateAllPromotions();
  });

  it("Concurrency: two bundle checkouts on exactly-emptied stock — one wins", async () => {
    await deactivateAllPromotions();
    await createBundle({
      name: `Race Pack ${stamp}`,
      rule: { bundlePrice: 50 },
      components: [{ variantId: variantA, quantity: 2 }],
    });
    // Exactly two units of A: two concurrent bundle carts race for them.
    await dbQuery(
      `UPDATE inventory_stock SET quantity = 2 WHERE business_id = $1 AND variant_id = $2 AND location_id = $3`,
      [owner.businessId, variantA, locationId],
    );

    const saleBody = {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 110, tendered: 110 }],
      discount: null,
      vatPercent: 0,
      items: [
        { variantId: variantA, quantity: 2, unitPrice: 100, discount: null },
        { variantId: variantB, quantity: 2, unitPrice: 30, discount: null },
      ],
    };
    const [r1, r2] = await Promise.allSettled([
      api(owner, "POST", "/api/sales", saleBody),
      api(owner, "POST", "/api/sales", saleBody),
    ]);
    const statuses = [r1, r2].map((r) =>
      r.status === "fulfilled" ? r.value.status : 0,
    );
    statuses.sort((a, b) => a - b); // 201 first (404 > 201 numerically)
    assert.equal(statuses[0], 201, `exactly one checkout succeeds: ${JSON.stringify(statuses)}`);
    // The loser is rejected by the stock guard — validateStock throws 404
    // (NotFoundError) before FIFO consumption's 409 can fire.
    assert.equal(statuses[1], 404, `the loser is rejected: ${JSON.stringify(statuses)}`);
    assert.equal(await stockOf(variantA), 0);
  });
});
