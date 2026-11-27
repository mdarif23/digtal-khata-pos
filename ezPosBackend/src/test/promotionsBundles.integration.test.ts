/**
 * Bundle & Combo Phase 1 integration tests — fixed bundles.
 *
 * Covers the 'bundle' promo kind end-to-end: CRUD validation + ownership,
 * quote evaluation (package price, savings, near-miss, repetitions,
 * maxApplications, percent mode), stacking guards, checkout attribution
 * (price_adjustments + promotion_usage), component stock/COGS flow, partial
 * refund pro-rata, void release and tenant isolation.
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

describe("bundle promotions (phase 1)", { skip: !runIntegration }, () => {
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
  let variantA = 0; // sells ৳100, costs ৳50
  let variantB = 0; // sells ৳30, costs ৳15

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
          batchNumber: `P95-${sku}`,
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

  let unitId = 0;

  before(async () => {
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Bundle Test",
        email: `bundle-owner-${stamp}@example.test`,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `bundle-owner-${stamp}@example.test`,
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
      body: JSON.stringify({ name: `Bundle Biz ${stamp}` }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business: { id: number } };
    owner = {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
      email: `bundle-owner-${stamp}@example.test`,
    };

    const loc = await api(owner, "POST", "/api/locations", {
      name: `Bundle Main ${stamp}`,
    });
    locationId = payload<{ data: { id: number } }>(loc).data.id;

    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Pcs ${stamp}`,
      abbreviation: "Pcs",
    });
    unitId = payload<{ data: { value: number } }>(unitRes).data.value;
    variantA = await makeVariant(`Bundle Notebook ${stamp}`, `BNA-${stamp}`, 100);
    variantB = await makeVariant(`Bundle Pen ${stamp}`, `BNP-${stamp}`, 30);
  });

  const bundleInput = (over: Record<string, unknown> = {}) => ({
    name: `School Pack ${stamp}`,
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

  async function createBundle(over: Record<string, unknown> = {}): Promise<number> {
    const res = await api(owner, "POST", "/api/promotions", bundleInput(over));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return payload<{ data: { id: number } }>(res).data.id;
  }

  async function patchBundle(id: number, body: Record<string, unknown>) {
    const res = await api(owner, "PATCH", `/api/promotions/${id}`, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res;
  }

  async function setActive(id: number, isActive: boolean) {
    await patchBundle(id, { isActive });
  }

  async function quote(items: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
    const res = await api(owner, "POST", "/api/sales/quote", {
      customerId: null,
      items,
      payments: [],
      discount: null,
      vatPercent: 0,
      ...extra,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = payload<{ data: Record<string, unknown> }>(res).data;
    const promotions = data.promotions as
      | { applied: { id: number; name: string; amount: number }[]; total: number }
      | undefined;
    return {
      promotionsTotal: promotions?.total ?? 0,
      applied: promotions?.applied ?? [],
      nearMisses: (data.nearMisses as { id: number; reason: string }[] | undefined) ?? [],
      finalTotal: Number(data.finalTotal),
    };
  }

  function withCart(a = variantA, b = variantB) {
    return [
      { variantId: a, quantity: 1, unitPrice: 100, discount: null },
      { variantId: b, quantity: 2, unitPrice: 30, discount: null },
    ];
  }

  /** Fails in one test must not leak an active promotion into the next —
   * the phase3 harness pattern. */
  async function deactivateAllPromotions(): Promise<void> {
    await dbQuery(
      "UPDATE pricing_promotions SET is_active = false WHERE business_id = $1",
      [owner.businessId],
    );
  }

  // --- CRUD -----------------------------------------------------------------

  it("bundle CRUD: write-time validation", async () => {
    const cases: { body: Record<string, unknown>; label: string }[] = [
      { body: bundleInput({ components: [] }), label: "no components" },
      {
        body: bundleInput({ rule: { bundlePrice: 95, discountPercent: 10 } }),
        label: "both price modes",
      },
      { body: bundleInput({ rule: {} }), label: "neither price mode" },
      {
        body: bundleInput({ components: [{ variantId: 987654321, quantity: 1 }] }),
        label: "foreign variant",
      },
      {
        body: bundleInput({
          components: [
            { variantId: variantA, quantity: 1 },
            { variantId: variantA, quantity: 2 },
          ],
        }),
        label: "duplicate variant",
      },
      { body: bundleInput({ variantId: variantA }), label: "scope on bundle" },
      {
        body: {
          name: `Not A Bundle ${stamp}`,
          discountType: "fixed",
          discountValue: 5,
          promoKind: "discount",
          components: [{ variantId: variantA, quantity: 1 }],
        },
        label: "components on non-bundle kind",
      },
    ];
    for (const c of cases) {
      const res = await api(owner, "POST", "/api/promotions", c.body);
      assert.notEqual(res.status, 201, `${c.label} should be rejected`);
      assert.ok([400, 404].includes(res.status), `${c.label} → ${res.status}`);
    }
  });

  it("bundle CRUD: create persists components, get/list expose them, update replaces", async () => {
    await deactivateAllPromotions();
    const id = await createBundle();
    const got = payload<{
      data: {
        components: { variantId: number; quantity: number }[];
        componentTotal: number;
        discountType: string;
        discountValue: number;
      };
    }>(await api(owner, "GET", `/api/promotions/${id}`)).data;
    assert.equal(got.components.length, 2);
    assert.deepEqual(
      got.components
        .map((c) => [c.variantId, c.quantity])
        .sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0)),
      [
        [variantA, 1],
        [variantB, 2],
      ],
    );
    assert.equal(got.componentTotal, 160); // 100×1 + 30×2
    // Vestigial columns are normalized on bundles.
    assert.equal(got.discountType, "fixed");
    assert.equal(got.discountValue, 0);

    const listed = payload<{ data: { id: number; components: unknown[] }[] }>(
      await api(owner, "GET", "/api/promotions"),
    ).data;
    assert.ok(listed.some((p) => p.id === id && p.components.length === 2));

    // Replace components wholesale.
    await patchBundle(id, {
      components: [{ variantId: variantB, quantity: 3 }],
    });
    const after = payload<{
      data: { components: { variantId: number; quantity: number }[] };
    }>(await api(owner, "GET", `/api/promotions/${id}`)).data;
    assert.deepEqual(
      after.components.map((c) => [c.variantId, c.quantity]),
      [[variantB, 3]],
    );

    // Switching kind away drops the (now meaningless) component rows.
    await patchBundle(id, { promoKind: "discount", discountType: "fixed", discountValue: 5, rule: null });
    const switched = payload<{ data: { components: unknown[] } }>(
      await api(owner, "GET", `/api/promotions/${id}`),
    ).data;
    assert.equal(switched.components.length, 0);
    await setActive(id, false);

    const rows = await dbQuery(
      "SELECT count(*)::int AS n FROM promotion_bundle_components WHERE promotion_id = $1",
      [id],
    );
    assert.equal(rows[0]!.n, 0);
  });

  // --- Quote evaluation -------------------------------------------------------

  it("bundle quote: exact package price with line-scoped allocation", async () => {
    await deactivateAllPromotions();
    const id = await createBundle();
    // 1×100 + 2×30 = 160 → bundle 95 → 65 off.
    const q = await quote(withCart());
    assert.equal(q.promotionsTotal, 65);
    assert.equal(q.finalTotal, 95);
    assert.equal(q.nearMisses.length, 0);
    assert.deepEqual(q.applied.map((a) => a.id), [id]);
    await setActive(id, false);
  });

  it("bundle quote: near-miss names the first short component", async () => {
    await deactivateAllPromotions();
    const id = await createBundle();
    const q = await quote([
      { variantId: variantA, quantity: 1, unitPrice: 100, discount: null },
      { variantId: variantB, quantity: 1, unitPrice: 30, discount: null },
    ]);
    assert.equal(q.promotionsTotal, 0);
    const miss = q.nearMisses.find((m) => m.id === id);
    assert.ok(miss, "expected a near-miss for the short bundle");
    assert.match(miss.reason, /Add 1 more Bundle Pen/);
    await setActive(id, false);
  });

  it("bundle quote: repetitions double the discount; maxApplications caps it", async () => {
    await deactivateAllPromotions();
    const id = await createBundle();
    // Two complete bundles: 2×160 − 2×95 = 130 off.
    const q2 = await quote([
      { variantId: variantA, quantity: 2, unitPrice: 100, discount: null },
      { variantId: variantB, quantity: 4, unitPrice: 30, discount: null },
    ]);
    assert.equal(q2.promotionsTotal, 130);
    assert.equal(q2.finalTotal, 190);

    await patchBundle(id, { rule: { bundlePrice: 95, maxApplications: 1 } });
    const capped = await quote([
      { variantId: variantA, quantity: 2, unitPrice: 100, discount: null },
      { variantId: variantB, quantity: 4, unitPrice: 30, discount: null },
    ]);
    assert.equal(capped.promotionsTotal, 65);
    assert.equal(capped.finalTotal, 255); // 320 − 65
    await setActive(id, false);
  });

  it("bundle quote: percent mode discounts the covered component total", async () => {
    await deactivateAllPromotions();
    const id = await createBundle({ rule: { discountPercent: 10 } });
    const q = await quote(withCart());
    assert.equal(q.promotionsTotal, 16); // 10% of 160
    assert.equal(q.finalTotal, 144);
    await setActive(id, false);
  });

  it("bundle quote: non-beneficial or guarded bundles stay silent", async () => {
    await deactivateAllPromotions();
    const expensive = await createBundle({ rule: { bundlePrice: 200 } });
    const qExpensive = await quote(withCart());
    assert.equal(qExpensive.promotionsTotal, 0);
    await setActive(expensive, false);

    const guarded = await createBundle({ minOrderValue: 1000 });
    const qGuarded = await quote(withCart());
    assert.equal(qGuarded.promotionsTotal, 0);
    assert.ok(
      qGuarded.nearMisses.some((m) => m.id === guarded && /to qualify/.test(m.reason)),
    );
    await setActive(guarded, false);

    const scoped = await createBundle({ locationId: locationId + 5000 });
    const qScoped = await quote(withCart());
    assert.equal(qScoped.promotionsTotal, 0);
    assert.equal(qScoped.nearMisses.length, 0); // other location — not a near miss
    await setActive(scoped, false);
  });

  it("bundle quote: fractional component quantities work on whole carts", async () => {
    await deactivateAllPromotions();
    // Component 0.5 of A (৳100): one cart unit forms TWO bundles covering
    // the whole line → covered value 100 → 10% = 10 off.
    const id = await createBundle({
      rule: { discountPercent: 10 },
      components: [{ variantId: variantA, quantity: 0.5 }],
    });
    const q = await quote([
      { variantId: variantA, quantity: 1, unitPrice: 100, discount: null },
    ]);
    assert.equal(q.promotionsTotal, 10);
    assert.equal(q.finalTotal, 90);
    await setActive(id, false);
  });

  it("bundle stacks only with consent: coupon suppresses by default", async () => {
    await deactivateAllPromotions();
    const coupon = await api(owner, "POST", "/api/coupons", {
      code: `BNDL-${stamp}`,
      discountType: "fixed",
      value: 10,
    });
    assert.equal(coupon.status, 201, JSON.stringify(coupon.body));
    const id = await createBundle();
    const q = await quote(withCart(), { couponCode: `BNDL-${stamp}` });
    assert.equal(q.promotionsTotal, 0); // bundle does not consent to coupons
    await patchBundle(id, { canStackWithCoupons: true });
    const consented = await quote(withCart(), { couponCode: `BNDL-${stamp}` });
    // Bundle 65 on post-group 160; coupon fixed 10 on the post-bundle 95.
    assert.equal(consented.promotionsTotal, 65);
    assert.equal(consented.finalTotal, 85);
    await setActive(id, false);
  });

  // --- Checkout ---------------------------------------------------------------

  it("bundle checkout: totals, snapshots, usage counters, stock, COGS, refund, void", async () => {
    await deactivateAllPromotions();
    const id = await createBundle();
    const stockBefore = await dbQuery(
      `SELECT variant_id, quantity FROM inventory_stock WHERE business_id = $1 AND variant_id IN ($2, $3) AND location_id = $4 ORDER BY variant_id`,
      [owner.businessId, variantA, variantB, locationId],
    );

    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 95, tendered: 95 }],
      discount: null,
      vatPercent: 0,
      items: withCart(),
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const saleData = payload<{
      data: { sale: { id: number; finalTotal: number; discount: number } };
    }>(sale).data.sale;
    assert.equal(saleData.finalTotal, 95);
    assert.equal(saleData.discount, 65);

    const items = await dbQuery(
      `SELECT id, variant_id, cost_at_sale, price_adjustments FROM sale_items WHERE sale_id = $1 ORDER BY variant_id`,
      [saleData.id],
    );
    assert.equal(items.length, 2);
    const aRow = items.find((r) => r.variant_id === variantA)!;
    const bRow = items.find((r) => r.variant_id === variantB)!;
    const aAdj = aRow.price_adjustments.filter((a: { kind: string }) => a.kind === "promotion");
    const bAdj = bRow.price_adjustments.filter((a: { kind: string }) => a.kind === "promotion");
    assert.equal(aAdj.length, 1);
    assert.equal(bAdj.length, 1);
    assert.equal(aAdj[0]!.refId, id);
    assert.equal(aAdj[0]!.name, `School Pack ${stamp}`);
    // Pro-rata over covered values 100/60 with last-line remainder: 40.63 / 24.37.
    assert.equal(aAdj[0]!.amount, 40.63);
    assert.equal(bAdj[0]!.amount, 24.37);
    // COGS comes from the components' own batches, not the bundle price.
    assert.equal(Number(aRow.cost_at_sale), 50);
    assert.equal(Number(bRow.cost_at_sale), 15);

    const usage = await dbQuery(
      `SELECT count(*)::int AS n FROM promotion_usage WHERE business_id = $1 AND sale_id = $2 AND promotion_id = $3`,
      [owner.businessId, saleData.id, id],
    );
    assert.equal(usage[0]!.n, 1);

    const stockAfter = await dbQuery(
      `SELECT variant_id, quantity FROM inventory_stock WHERE business_id = $1 AND variant_id IN ($2, $3) AND location_id = $4 ORDER BY variant_id`,
      [owner.businessId, variantA, variantB, locationId],
    );
    const beforeA = stockBefore.find((r) => r.variant_id === variantA)!.quantity;
    const afterA = stockAfter.find((r) => r.variant_id === variantA)!.quantity;
    const beforeB = stockBefore.find((r) => r.variant_id === variantB)!.quantity;
    const afterB = stockAfter.find((r) => r.variant_id === variantB)!.quantity;
    assert.equal(Number(beforeA) - Number(afterA), 1);
    assert.equal(Number(beforeB) - Number(afterB), 2);

    // Void (before any refund — voiding requires a zero-refund sale)
    // releases the promotion usage counter and restores component stock.
    const cancel = await api(owner, "POST", `/api/sales/${saleData.id}/cancel`, {
      reason: "bundle void test",
    });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    const usageAfterVoid = await dbQuery(
      `SELECT count(*)::int AS n FROM promotion_usage WHERE business_id = $1 AND sale_id = $2 AND promotion_id = $3`,
      [owner.businessId, saleData.id, id],
    );
    assert.equal(usageAfterVoid[0]!.n, 0);
    const stockAfterVoid = await dbQuery(
      `SELECT variant_id, quantity FROM inventory_stock WHERE business_id = $1 AND variant_id IN ($2, $3) AND location_id = $4 ORDER BY variant_id`,
      [owner.businessId, variantA, variantB, locationId],
    );
    assert.equal(Number(stockAfterVoid.find((r) => r.variant_id === variantA)!.quantity), Number(beforeA));
    assert.equal(Number(stockAfterVoid.find((r) => r.variant_id === variantB)!.quantity), Number(beforeB));

    // Second sale: partial return of ONE pen. refunds_all defaults absent
    // lines to a FULL return, so the notebook line is explicitly left at 0.
    // The effective per-line value spreads the sale-level delta
    // (finalTotal − Σ lineTotal = 95 − 160) pro-rata, so the bundle discount
    // is included: pen line 60 − 65×(60/160) = 35.63; one of two units → 17.82.
    const sale2 = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 95, tendered: 95 }],
      discount: null,
      vatPercent: 0,
      items: withCart(),
    });
    assert.equal(sale2.status, 201, JSON.stringify(sale2.body));
    const sale2Data = payload<{ data: { sale: { id: number } } }>(sale2).data.sale;
    const items2 = await dbQuery(
      `SELECT id, variant_id FROM sale_items WHERE sale_id = $1`,
      [sale2Data.id],
    );
    const aRow2 = items2.find((r) => r.variant_id === variantA)!;
    const bRow2 = items2.find((r) => r.variant_id === variantB)!;
    const refund = await api(owner, "POST", `/api/sold_products/refunds_all/${sale2Data.id}`, {
      reason: "customer_request",
      disposition: "restock",
      refundMethod: "cash",
      quantities: [
        { saleItemId: aRow2.id, quantity: 0 },
        { saleItemId: bRow2.id, quantity: 1 },
      ],
    });
    assert.equal(refund.status, 200, JSON.stringify(refund.body));
    const refundRow = await dbQuery(
      `SELECT refund_total FROM sale_refunds WHERE sale_id = $1 ORDER BY id DESC LIMIT 1`,
      [sale2Data.id],
    );
    assert.equal(Number(refundRow[0]!.refund_total), 17.82);

    const restockB = await dbQuery(
      `SELECT quantity FROM inventory_stock WHERE business_id = $1 AND variant_id = $2 AND location_id = $3`,
      [owner.businessId, variantB, locationId],
    );
    assert.equal(Number(restockB[0]!.quantity), Number(beforeB) - 1);
    await setActive(id, false);
  });

  // --- POS active-bundles feed (Phase 2) ---------------------------------------

  it("active-bundles: lists live bundles with components; hides guarded ones", async () => {
    await deactivateAllPromotions();
    // Burn the limited bundle's single usage while it is the ONLY active
    // promotion, so the burn sale totals exactly the bundle price.
    const limited = await createBundle({ name: `Spent Pack ${stamp}`, usageLimit: 1 });
    const burnSale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 95, tendered: 95 }],
      discount: null,
      vatPercent: 0,
      items: withCart(),
    });
    assert.equal(burnSale.status, 201, JSON.stringify(burnSale.body));
    // Still active — but fully redeemed, so the feed must hide it.
    const live = await createBundle({ name: `Live Pack ${stamp}` });
    const expired = await createBundle({ name: `Expired Pack ${stamp}`, endsAt: "2020-01-01" });
    const scoped = await createBundle({ name: `Scoped Pack ${stamp}`, locationId: locationId + 5000 });

    const res = await api(owner, "GET", `/api/promotions/active-bundles?locationId=${locationId}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const bundles = payload<{
      data: {
        id: number;
        name: string;
        rule: Record<string, unknown> | null;
        components: { variantId: number; quantity: number; sellingPrice: number }[];
        normalTotal: number;
      }[];
    }>(res).data;
    const ids = bundles.map((b) => b.id);
    assert.ok(ids.includes(live), "live bundle must be advertised");
    assert.ok(!ids.includes(expired), "expired bundle must be hidden");
    assert.ok(!ids.includes(scoped), "other-location bundle must be hidden");
    assert.ok(!ids.includes(limited), "fully redeemed bundle must be hidden");

    const liveBundle = bundles.find((b) => b.id === live)!;
    assert.equal(liveBundle.components.length, 2);
    assert.equal(liveBundle.normalTotal, 160);
    assert.equal(liveBundle.rule?.bundlePrice, 95);

    await deactivateAllPromotions();
    await api(owner, "POST", `/api/sales/${payload<{ data: { sale: { id: number } } }>(burnSale).data.sale.id}/cancel`, {
      reason: "cleanup burn sale",
    });
  });

  it("active-bundles: skips flash-window mismatches and malformed bundles", async () => {
    await deactivateAllPromotions();
    // A flash window far outside the current Asia/Dhaka day/time.
    const currentDow = new Date(Date.now() + 6 * 3_600_000).getUTCDay();
    const wrongDay = (currentDow + 1) % 7;
    const wrongDayBundle = await createBundle({ name: `Wrong Day ${stamp}`, daysOfWeek: [wrongDay] });
    const noComponents = await createBundle();
    await dbQuery("DELETE FROM promotion_bundle_components WHERE promotion_id = $1", [noComponents]);

    const res = await api(owner, "GET", "/api/promotions/active-bundles");
    const ids = payload<{ data: { id: number }[] }>(res).data.map((b) => b.id);
    assert.ok(!ids.includes(wrongDayBundle), "wrong-day flash bundle must be hidden");
    assert.ok(!ids.includes(noComponents), "componentless bundle must never be advertised");

    await deactivateAllPromotions();
  });

  // --- Tenancy ----------------------------------------------------------------

  it("bundle promotions are isolated per tenant", async () => {
    const email = `bundle-b-${stamp}@example.test`;
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Bundle B", email, password: "strong-password-123" }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    const tokenB = ((await login.json()) as { accessToken: string }).accessToken;
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({ name: `Bundle Biz B ${stamp}` }),
    });
    const businessIdB = ((await biz.json()) as { business: { id: number } }).business.id;
    const ctxB: Ctx = { token: tokenB, businessId: businessIdB, userId: 0, email };

    const foreignId = await createBundle();
    const listB = payload<{ data: unknown[] }>(
      await api(ctxB, "GET", "/api/promotions"),
    ).data;
    assert.equal(listB.length, 0);
    const patchForeign = await api(ctxB, "PATCH", `/api/promotions/${foreignId}`, {
      name: "Hijack",
    });
    assert.equal(patchForeign.status, 404);
    await setActive(foreignId, false);
  });
});
