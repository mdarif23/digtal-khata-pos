/**
 * Auto-applied promotions integration tests — Phase 5 (report §18 gate:
 * stacking matrix tests). Covers: promotion CRUD + validation (scope XOR,
 * percentage cap, date order, group eligibility), the sale-time layer through
 * quote + createSale (whole-cart and scoped promotions, stacking consent with
 * the group layer and with coupons, minimums, date windows, caps, group
 * restrictions incl. walk-ins), the price_adjustments snapshots in
 * application order (group → promotion), quote == checkout totals, tenant
 * isolation, and the promotions permission matrix.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("pricing promotions integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let pgClient: import("pg").Client | undefined;

  before(async () => {
    const { default: pg } = await import("pg");
    pgClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await pgClient.connect();
    const db = await pgClient.query("SELECT current_database() AS db");
    if (db.rows[0]?.db !== "ezpos_test") {
      throw new Error(
        `SAFETY ABORT: connected to "${db.rows[0]?.db}" — integration tests may only run against ezpos_test.`,
      );
    }
    await pgClient.query(
      `INSERT INTO subscription_plans (name, slug, interval, price, currency, is_active)
       VALUES ('Free trial', 'free-trial', 'monthly', 0, 'BDT', true)
       ON CONFLICT (slug) DO UPDATE
       SET limits = NULL,
           features = '{"multiLocation":true,"advancedReports":true,"storefrontApi":true,"woocommerceIntegration":true,"customStorefront":true,"multipleOnlineStores":true,"advancedWebhooks":true}'::jsonb,
           is_active = true`,
    );
    const { ensureRbacSeed } = await import("../rbac/seed.js");
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

  const uniqueEmail = () =>
    `pricing-promos-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let locationId = 0;
  let categoryId = 0;
  let variantCat = 0; // price 100, in categoryId
  let variantPlain = 0; // price 200, no category
  let groupId = 0; // "Members" — whole-cart fixed 40, stacks with promotions
  let customerMember = 0; // member of groupId
  let vipGroupId = 0; // group with no members until one test adds them

  async function api(
    method: string,
    path: string,
    body?: unknown,
    overrides: Record<string, string> = {},
  ) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
        ...overrides,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  function quote(body: Record<string, unknown>) {
    return api("POST", "/api/sales/quote", {
      cartDiscount: null,
      vatPercent: null,
      ...body,
    });
  }

  /** Creates a promotion and returns its id. */
  async function makePromotion(payload: Record<string, unknown>): Promise<number> {
    const res = await api("POST", "/api/promotions", payload);
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return (res.json as { data: { id: number } }).data.id;
  }

  async function setActive(id: number, isActive: boolean): Promise<void> {
    const res = await api("PATCH", `/api/promotions/${id}`, { isActive });
    assert.equal(res.status, 200);
  }

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Promos Owner", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Promos Biz ${Date.now()}` }),
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
    locationId = ((await loc.json()) as { data: { id: number } }).data.id;

    const cat = await api("POST", "/api/product/category", {
      categoryName: `Promo Cat ${Date.now()}`,
      parentCategoryId: null,
      description: "",
      status: "active",
    });
    assert.equal(cat.status, 201);
    categoryId = cat.json.data.value;

    const variants: number[] = [];
    for (const spec of [
      { name: "Promo Cat Product", price: 100, withCategory: true },
      { name: "Promo Plain Product", price: 200, withCategory: false },
    ]) {
      const unit = await api("POST", "/api/product/unit", {
        unitName: `${spec.name} Unit ${Date.now()}`,
        abbreviation: "pu",
      });
      const unitId = (unit.json as { data: { value: number } }).data.value;
      const prod = await api("POST", "/api/product", {
        name: spec.name,
        categoryId: spec.withCategory ? categoryId : null,
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
            sellingPrice: spec.price,
            alertQuantity: 0,
            isDefault: true,
            status: "active",
            imageUrl: null,
            imageFile: null,
            batchNumber: "",
            purchasePrice: 50,
            quantity: 30,
            expiryDate: null,
          },
        ],
      });
      assert.equal(prod.status, 201, JSON.stringify(prod.json));
      const list = await api("GET", "/api/products");
      const found = (list.json as { id: number; name: string }[]).find(
        (p) => p.name === spec.name,
      )!;
      const detail = await api("GET", `/api/product/${found.id}`);
      variants.push(
        (detail.json as { variants: { id: number }[] }).variants[0]!.id,
      );
    }
    variantCat = variants[0]!;
    variantPlain = variants[1]!;

    const group = await api("POST", "/api/customer-groups", { name: "Members" });
    groupId = group.json.data.id;
    const pricing = await api("POST", `/api/customer-groups/${groupId}/pricing`, {
      discountType: "fixed",
      discountValue: 40,
    });
    assert.equal(pricing.status, 201);
    const vip = await api("POST", "/api/customer-groups", { name: "VIP" });
    vipGroupId = vip.json.data.id;

    const cust = await api("POST", "/api/customers", {
      name: "Member Customer",
      phone: "1722000001",
    });
    customerMember = cust.json.id;
    const assign = await api("PUT", `/api/customer-groups/${groupId}/members`, {
      customerIds: [customerMember],
    });
    assert.equal(assign.status, 200);
  });

  // --- CRUD + validation -------------------------------------------------------

  it("creates, lists, updates and deletes promotions", async () => {
    const created = await makePromotion({
      name: "Summer Sale",
      discountType: "percentage",
      discountValue: 10,
    });
    const single = await api("GET", `/api/promotions/${created}`);
    assert.equal(single.status, 200);
    assert.equal((single.json as { data: { name: string } }).data.name, "Summer Sale");

    const list = await api("GET", "/api/promotions");
    const row = (list.json as { data: { id: number; scopeLabel: string; customerGroups: unknown[] }[] })
      .data.find((p) => p.id === created)!;
    assert.equal(row.scopeLabel, "Whole business");
    assert.deepEqual(row.customerGroups, []);

    const patched = await api("PATCH", `/api/promotions/${created}`, {
      name: "Summer Sale Renamed",
      discountValue: 12,
    });
    assert.equal(patched.status, 200);
    assert.equal((patched.json as { data: { discountValue: number } }).data.discountValue, 12);

    const deleted = await api("DELETE", `/api/promotions/${created}`);
    assert.equal(deleted.status, 200);
    const gone = await api("GET", `/api/promotions/${created}`);
    assert.equal(gone.status, 404);
  });

  it("rejects invalid promotion shapes (percentage cap, multi-scope, date order)", async () => {
    const badPct = await api("POST", "/api/promotions", {
      name: "Too Much",
      discountType: "percentage",
      discountValue: 120,
    });
    assert.equal(badPct.status, 400);

    const multiScope = await api("POST", "/api/promotions", {
      name: "Multi",
      categoryId,
      productId: 1,
      discountType: "fixed",
      discountValue: 5,
    });
    assert.equal(multiScope.status, 400);

    const badDates = await api("POST", "/api/promotions", {
      name: "Backwards",
      discountType: "fixed",
      discountValue: 5,
      startsAt: new Date("2026-12-31").toISOString(),
      endsAt: new Date("2026-01-01").toISOString(),
    });
    assert.equal(badDates.status, 400);

    const foreignGroup = await api("POST", "/api/promotions", {
      name: "Foreign Group",
      discountType: "fixed",
      discountValue: 5,
      groupIds: [99999999],
    });
    assert.equal(foreignGroup.status, 404);
  });

  it("manages group eligibility (replace semantics)", async () => {
    const id = await makePromotion({
      name: "VIP Only",
      discountType: "fixed",
      discountValue: 5,
      groupIds: [vipGroupId],
    });
    const single = await api("GET", `/api/promotions/${id}`);
    assert.deepEqual(
      (single.json as { data: { customerGroups: { id: number }[] } }).data.customerGroups,
      [{ id: vipGroupId }],
    );
    const list = await api("GET", "/api/promotions");
    const row = (list.json as { data: { id: number; customerGroups: { id: number; name: string }[] }[] })
      .data.find((p) => p.id === id)!;
    assert.deepEqual(row.customerGroups, [{ id: vipGroupId, name: "VIP" }]);

    // Empty list = everyone eligible again.
    await api("PATCH", `/api/promotions/${id}`, { groupIds: [] });
    const cleared = await api("GET", `/api/promotions/${id}`);
    assert.deepEqual(
      (cleared.json as { data: { customerGroups: unknown[] } }).data.customerGroups,
      [],
    );
    await setActive(id, false);
  });

  // --- quote stacking matrix -----------------------------------------------------

  it("applies a whole-cart promotion to walk-ins", async () => {
    const id = await makePromotion({
      name: "Walk-in Sale",
      discountType: "percentage",
      discountValue: 10,
    });
    const res = await quote({
      items: [
        { variantId: variantCat, quantity: 1, discount: null },
        { variantId: variantPlain, quantity: 1, discount: null },
      ],
    });
    const data = (res.json as { data: { finalTotal: number; promotions?: { total: number; applied: { name: string }[] } } }).data;
    assert.equal(data.promotions?.total, 30);
    assert.equal(data.promotions?.applied[0]?.name, "Walk-in Sale");
    assert.equal(data.finalTotal, 270);
    await setActive(id, false);
  });

  it("stacks a promotion with the group discount when BOTH sides consent", async () => {
    // Group fixed 40 on cart 300 → post-group 260; promo 15% of 260 = 39.
    const id = await makePromotion({
      name: "Member Extra",
      discountType: "percentage",
      discountValue: 15,
      canStackWithGroupDiscount: true,
    });
    const res = await quote({
      items: [
        { variantId: variantCat, quantity: 1, discount: null },
        { variantId: variantPlain, quantity: 1, discount: null },
      ],
      customerId: customerMember,
    });
    const data = (res.json as {
      data: { finalTotal: number; group: { discountAmount: number }; promotions: { total: number } };
    }).data;
    assert.equal(data.group.discountAmount, 40);
    assert.equal(data.promotions.total, 39);
    assert.equal(data.finalTotal, 300 - 40 - 39);
    await setActive(id, false);
  });

  it("skips the promotion when the promotion refuses the group layer", async () => {
    const id = await makePromotion({
      name: "Groupless Only",
      discountType: "percentage",
      discountValue: 15,
      canStackWithGroupDiscount: false,
    });
    const member = await quote({
      items: [{ variantId: variantCat, quantity: 3, discount: null }],
      customerId: customerMember,
    });
    const memberData = (member.json as { data: { finalTotal: number; promotions?: unknown; group: unknown } }).data;
    assert.equal(memberData.promotions, undefined);
    assert.equal(memberData.finalTotal, 260); // 300 − 40 group only

    // Same promotion applies to a walk-in (no group layer to refuse).
    const walkin = await quote({
      items: [{ variantId: variantCat, quantity: 3, discount: null }],
    });
    assert.equal(
      (walkin.json as { data: { promotions: { total: number } } }).data.promotions.total,
      45,
    );
    await setActive(id, false);
  });

  it("skips the promotion when the applied group-pricing row refuses promotions", async () => {
    // A second group row that refuses stacking; the member's group layer is
    // then non-consenting, so even a willing promotion is skipped.
    const refusingRow = await api("POST", `/api/customer-groups/${groupId}/pricing`, {
      discountType: "percentage",
      discountValue: 5,
      stacksWithPromotions: false,
    });
    assert.equal(refusingRow.status, 201);
    const willing = await makePromotion({
      name: "Willing Stacker",
      discountType: "percentage",
      discountValue: 15,
      canStackWithGroupDiscount: true,
    });

    const res = await quote({
      items: [{ variantId: variantCat, quantity: 3, discount: null }],
      customerId: customerMember,
    });
    const data = (res.json as { data: { promotions?: unknown; group: { discountAmount: number } } }).data;
    assert.equal(data.promotions, undefined);
    assert.equal(data.group.discountAmount, 55); // 40 + 15 both group rows

    await api("DELETE", `/api/customer-groups/${groupId}/pricing/${refusingRow.json.data.id}`);
    await setActive(willing, false);
  });

  it("scopes promotions to category lines and computes them on post-group bases", async () => {
    const id = await makePromotion({
      name: "Category Deal",
      categoryId,
      discountType: "percentage",
      discountValue: 10,
    });
    // Line 1 (cat, 100) gets 10; line 2 (plain, 200) gets nothing.
    const res = await quote({
      items: [
        { variantId: variantCat, quantity: 1, discount: null },
        { variantId: variantPlain, quantity: 1, discount: null },
      ],
      customerId: customerMember,
    });
    const data = (res.json as { data: { finalTotal: number; promotions: { total: number } } }).data;
    // Post-group line 1: 100 − 40×(100/300)=13.33… → 86.67; 10% → 8.67.
    assert.equal(data.promotions.total, 8.67);
    assert.equal(data.finalTotal, 300 - 40 - 8.67);
    await setActive(id, false);
  });

  it("enforces minOrderValue on the post-group total, minQuantity and the date window", async () => {
    const minOrder = await makePromotion({
      name: "Big Basket",
      discountType: "fixed",
      discountValue: 50,
      minOrderValue: 500,
    });
    // Cart 300 < 500 post-group → not applied.
    const small = await quote({
      items: [{ variantId: variantCat, quantity: 3, discount: null }],
    });
    assert.equal(
      (small.json as { data: { promotions?: unknown } }).data.promotions,
      undefined,
    );
    // Cart 600 ≥ 500 → applied.
    const big = await quote({
      items: [{ variantId: variantPlain, quantity: 3, discount: null }],
    });
    assert.equal(
      (big.json as { data: { promotions: { total: number } } }).data.promotions.total,
      50,
    );
    await setActive(minOrder, false);

    const minQty = await makePromotion({
      name: "Buy Three",
      discountType: "fixed",
      discountValue: 20,
      minQuantity: 3,
    });
    const two = await quote({
      items: [{ variantId: variantCat, quantity: 2, discount: null }],
    });
    assert.equal((two.json as { data: { promotions?: unknown } }).data.promotions, undefined);
    const four = await quote({
      items: [{ variantId: variantCat, quantity: 4, discount: null }],
    });
    assert.equal(
      (four.json as { data: { promotions: { total: number } } }).data.promotions.total,
      20,
    );
    await setActive(minQty, false);

    const future = await makePromotion({
      name: "Not Started",
      discountType: "fixed",
      discountValue: 20,
      startsAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    });
    const notYet = await quote({
      items: [{ variantId: variantCat, quantity: 1, discount: null }],
    });
    assert.equal((notYet.json as { data: { promotions?: unknown } }).data.promotions, undefined);
    await setActive(future, false);
  });

  it("caps the promotion at maxDiscountAmount (whole-cart and scoped aggregate)", async () => {
    const wholeCart = await makePromotion({
      name: "Capped Sale",
      discountType: "percentage",
      discountValue: 50,
      maxDiscountAmount: 20,
    });
    const res = await quote({
      items: [{ variantId: variantCat, quantity: 2, discount: null }],
    });
    assert.equal(
      (res.json as { data: { promotions: { total: number } } }).data.promotions.total,
      20, // 50% of 200 = 100 → capped at 20
    );
    await setActive(wholeCart, false);

    const scoped = await makePromotion({
      name: "Capped Category",
      categoryId,
      discountType: "percentage",
      discountValue: 50,
      maxDiscountAmount: 30,
    });
    // 3 cat lines × 100: 50 each = 150 raw → capped at 30 aggregate.
    const scopedRes = await quote({
      items: [{ variantId: variantCat, quantity: 3, discount: null }],
    });
    assert.equal(
      (scopedRes.json as { data: { promotions: { total: number } } }).data.promotions.total,
      30,
    );
    await setActive(scoped, false);
  });

  it("group-restricted promotions exclude walk-ins and non-members", async () => {
    const id = await makePromotion({
      name: "VIP Deal",
      discountType: "fixed",
      discountValue: 10,
      groupIds: [vipGroupId],
    });
    // Walk-in: restricted promotion does not apply.
    const walkin = await quote({
      items: [{ variantId: variantCat, quantity: 1, discount: null }],
    });
    assert.equal((walkin.json as { data: { promotions?: unknown } }).data.promotions, undefined);
    // Member of the WRONG group: still excluded.
    const wrongGroup = await quote({
      items: [{ variantId: variantCat, quantity: 1, discount: null }],
      customerId: customerMember,
    });
    assert.equal((wrongGroup.json as { data: { promotions?: unknown } }).data.promotions, undefined);
    // Join VIP → applies (stacking with the Members group layer: fixed 10 on
    // the post-group 60).
    const join = await api("PUT", `/api/customer-groups/${vipGroupId}/members`, {
      customerIds: [customerMember],
    });
    assert.equal(join.status, 200);
    const member = await quote({
      items: [{ variantId: variantCat, quantity: 1, discount: null }],
      customerId: customerMember,
    });
    const data = (member.json as { data: { promotions: { total: number }; group: { discountAmount: number } } }).data;
    assert.equal(data.promotions.total, 10);
    assert.equal(data.group.discountAmount, 40);
    await api("DELETE", `/api/customer-groups/${vipGroupId}/members/${customerMember}`);
    await setActive(id, false);
  });

  it("coupon interplay: non-stacking promotions skip when a coupon is present", async () => {
    const coupon = await api("POST", "/api/coupons", {
      code: `PROMO10-${Date.now()}`,
      discountType: "fixed",
      value: 10,
    });
    assert.equal(coupon.status, 201);
    const couponCode = (coupon.json as { data: { code: string } }).data.code;

    const noStack = await makePromotion({
      name: "No Coupon Stack",
      discountType: "fixed",
      discountValue: 5,
      canStackWithCoupons: false,
    });
    const skipped = await quote({
      items: [{ variantId: variantCat, quantity: 1, discount: null }],
      couponCode,
    });
    const skippedData = (skipped.json as { data: { finalTotal: number; promotions?: unknown; coupon: { discountAmount: number } } }).data;
    assert.equal(skippedData.promotions, undefined);
    assert.equal(skippedData.coupon.discountAmount, 10);
    assert.equal(skippedData.finalTotal, 90);
    await setActive(noStack, false);

    const stacker = await makePromotion({
      name: "Coupon Stacker",
      discountType: "fixed",
      discountValue: 5,
      canStackWithCoupons: true,
    });
    const stacked = await quote({
      items: [{ variantId: variantCat, quantity: 1, discount: null }],
      couponCode,
    });
    const stackedData = (stacked.json as { data: { finalTotal: number; promotions: { total: number }; coupon: { discountAmount: number } } }).data;
    assert.equal(stackedData.promotions.total, 5);
    // Coupon fixed 10 bases on the post-promotion 95.
    assert.equal(stackedData.coupon.discountAmount, 10);
    assert.equal(stackedData.finalTotal, 85);
    await setActive(stacker, false);
  });

  // --- createSale snapshots -------------------------------------------------------

  it("createSale stamps promotion snapshots in application order and leaves prices untouched", async () => {
    const id = await makePromotion({
      name: "Checkout Deal",
      discountType: "percentage",
      discountValue: 15,
      canStackWithGroupDiscount: true,
    });
    const sale = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: customerMember,
      payments: [{ method: "cash", amount: 221, tendered: 221 }],
      discount: null,
      vatPercent: 0,
      items: [
        { variantId: variantCat, quantity: 1, unitPrice: 100, discount: null },
        { variantId: variantPlain, quantity: 1, unitPrice: 200, discount: null },
      ],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.json));
    const saleId = (sale.json as { data: { sale: { id: number; finalTotal: number } } }).data.sale.id;
    // Group fixed 40 (pro-rata 13.33/26.67) → post-group 86.67/173.33;
    // promo 15% of 260 = 39 (pro-rata 13/26 on post-group totals).
    assert.equal((sale.json as { data: { sale: { finalTotal: number } } }).data.sale.finalTotal, 221);

    const rows = await pgClient!.query(`SELECT discount FROM sales WHERE id = $1`, [saleId]);
    assert.equal(Number(rows.rows[0]!.discount), 79);

    const items = await pgClient!.query(
      `SELECT variant_id, price_adjustments FROM sale_items WHERE sale_id = $1 ORDER BY variant_id`,
      [saleId],
    );
    const adjustments = items.rows as {
      variant_id: number;
      price_adjustments: { kind: string; refId: number | null; name: string | null; amount: number }[];
    }[];
    const catRow = adjustments.find((r) => r.variant_id === variantCat)!;
    assert.equal(catRow.price_adjustments.length, 2);
    assert.equal(catRow.price_adjustments[0]!.kind, "group");
    assert.equal(catRow.price_adjustments[0]!.name, "Members");
    assert.equal(catRow.price_adjustments[1]!.kind, "promotion");
    assert.equal(catRow.price_adjustments[1]!.refId, id);
    assert.equal(catRow.price_adjustments[1]!.name, "Checkout Deal");
    assert.equal(catRow.price_adjustments[1]!.amount, 13);
    const plainRow = adjustments.find((r) => r.variant_id === variantPlain)!;
    assert.equal(plainRow.price_adjustments[1]!.amount, 26);

    // Separation invariant: the effective price was never touched.
    const list = await api("GET", "/api/products");
    const cat = (list.json as { name: string; variants: { sellingPrice: number }[] }[]).find(
      (p) => p.name === "Promo Cat Product",
    )!;
    assert.equal(cat.variants[0]!.sellingPrice, 100);
    await setActive(id, false);
  });

  it("keeps promotions isolated per tenant", async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Promos B", email, password: "strong-password-123" }),
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
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ name: `Promos Biz B ${Date.now()}` }),
    });
    const businessIdB = ((await biz.json()) as { business: { id: number } }).business.id;
    await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenB}`,
        "X-Business-Id": String(businessIdB),
      },
      body: JSON.stringify({ name: "Main Store" }),
    });

    const listB = await fetch(`${baseUrl}/api/promotions`, {
      headers: { Authorization: `Bearer ${tokenB}`, "X-Business-Id": String(businessIdB) },
    });
    assert.equal(((await listB.json()) as { data: unknown[] }).data.length, 0);

    // A foreign promotion id is not reachable.
    const foreignId = await makePromotion({
      name: "Foreign Probe",
      discountType: "fixed",
      discountValue: 1,
    });
    const cross = await fetch(`${baseUrl}/api/promotions/${foreignId}`, {
      headers: { Authorization: `Bearer ${tokenB}`, "X-Business-Id": String(businessIdB) },
    });
    assert.equal(cross.status, 404);
  });

  it("enforces permissions on promotion management", async () => {
    const roleRes = await api("POST", "/api/roles", {
      name: `Promos Viewer ${Date.now()}`,
      permissionKeys: ["promotions.view"],
    });
    const roleId = (roleRes.json as { data: { id: number } }).data.id;
    const userRes = await api("POST", "/api/users", {
      fullName: "Promos Viewer",
      email: uniqueEmail(),
      password: "strong-password-123",
      roleIds: [roleId],
      locationIds: [locationId],
    });
    const viewerEmail = (userRes.json as { data: { email: string } }).data.email;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: viewerEmail, password: "strong-password-123" }),
    });
    const viewerToken = ((await login.json()) as { accessToken: string }).accessToken;

    const read = await fetch(`${baseUrl}/api/promotions`, {
      headers: { Authorization: `Bearer ${viewerToken}`, "X-Business-Id": String(businessId) },
    });
    assert.equal(read.status, 200);

    const write = await fetch(`${baseUrl}/api/promotions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerToken}`,
        "X-Business-Id": String(businessId),
      },
      body: JSON.stringify({ name: "Nope", discountType: "fixed", discountValue: 1 }),
    });
    assert.equal(write.status, 403);
  });
});
