/**
 * Customer groups + group pricing integration tests — Phase 4 (report §18
 * gate: POS integration tests). Covers: group CRUD (default uniqueness, name
 * conflicts), membership assignment/removal, group-pricing CRUD validation,
 * the sale-time layer through quote + createSale (whole-cart, line-scoped,
 * stacking with manual discounts and coupons, VAT base reduction, walk-in
 * and group-less customers), the sale-time snapshots (sales.customer_group_id
 * + sale_items.price_adjustments), minimum gating, date windows, group
 * deactivation, tenant isolation, permissions, and the effective-price
 * separation invariant.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("customer group pricing integration", { skip: !runIntegration }, () => {
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
    `pricing-groups-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let locationId = 0;
  let categoryId = 0;
  let variantCat = 0; // price 100, cost 50, in categoryId
  let variantPlain = 0; // price 200, cost 100, no category
  let wholesaleId = 0;
  let customerA = 0; // wholesale member
  let wholeCartPricingId = 0;

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

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Groups Owner", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Groups Biz ${Date.now()}` }),
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
      categoryName: `Cat ${Date.now()}`,
      parentCategoryId: null,
      description: "",
      status: "active",
    });
    assert.equal(cat.status, 201);
    categoryId = cat.json.data.value;

    const products: { variantId: number }[] = [];
    for (const spec of [
      { name: "Grouped Product", price: 100, cost: 50, withCategory: true },
      { name: "Plain Product", price: 200, cost: 100, withCategory: false },
    ]) {
      const unit = await api("POST", "/api/product/unit", {
        unitName: `${spec.name} Unit ${Date.now()}`,
        abbreviation: "gu",
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
            purchasePrice: spec.cost,
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
      products.push({
        variantId: (detail.json as { variants: { id: number }[] }).variants[0]!.id,
      });
    }
    variantCat = products[0]!.variantId;
    variantPlain = products[1]!.variantId;

    // Customers: A will join Wholesale; B stays group-less.
    const custA = await api("POST", "/api/customers", {
      name: "Wholesale Customer",
      phone: "1711000001",
    });
    customerA = custA.json.id;
    await api("POST", "/api/customers", { name: "Groupless Customer", phone: "1711000002" });
  });

  // --- group CRUD -------------------------------------------------------------

  it("creates groups with unique names and a single default", async () => {
    const wholesale = await api("POST", "/api/customer-groups", { name: "Wholesale" });
    assert.equal(wholesale.status, 201);
    wholesaleId = wholesale.json.data.id;

    const dup = await api("POST", "/api/customer-groups", { name: "Wholesale" });
    assert.equal(dup.status, 409);

    const retail = await api("POST", "/api/customer-groups", {
      name: "Retail",
      isDefault: true,
    });
    assert.equal(retail.status, 201);
    const list = await api("GET", "/api/customer-groups");
    const defaults = (list.json.data as { id: number; name: string; isDefault: boolean }[]).filter((g) => g.isDefault);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0]!.name, "Retail");
  });

  it("assigns and removes members; rejects foreign or missing customers", async () => {
    const assign = await api("PUT", `/api/customer-groups/${wholesaleId}/members`, {
      customerIds: [customerA],
    });
    assert.equal(assign.status, 200);
    assert.equal(assign.json.data.assigned, 1);

    const members = await api("GET", `/api/customer-groups/${wholesaleId}/members`);
    assert.equal((members.json.data as { id: number }[]).length, 1);

    const foreign = await api("PUT", `/api/customer-groups/${wholesaleId}/members`, {
      customerIds: [99999999],
    });
    assert.equal(foreign.status, 404);
  });

  // --- group pricing CRUD -------------------------------------------------------

  it("creates group pricing rows with strict validation", async () => {
    const row = await api("POST", `/api/customer-groups/${wholesaleId}/pricing`, {
      discountType: "percentage",
      discountValue: 10,
    });
    assert.equal(row.status, 201);
    wholeCartPricingId = row.json.data.id;

    const badPct = await api("POST", `/api/customer-groups/${wholesaleId}/pricing`, {
      discountType: "percentage",
      discountValue: 120,
    });
    assert.equal(badPct.status, 400);

    const badDates = await api("POST", `/api/customer-groups/${wholesaleId}/pricing`, {
      discountType: "fixed",
      discountValue: 20,
      validFrom: "2030-01-02",
      validTo: "2030-01-01",
    });
    assert.equal(badDates.status, 400);

    const scoped = await api("POST", `/api/customer-groups/${wholesaleId}/pricing`, {
      categoryId,
      discountType: "percentage",
      discountValue: 5,
    });
    assert.equal(scoped.status, 201);
    const list = await api("GET", `/api/customer-groups/${wholesaleId}/pricing`);
    assert.equal((list.json.data as unknown[]).length, 2);
  });

  // --- quote: the sale-time layer ----------------------------------------------

  it("quotes the group layer: whole-cart + scoped discounts stack, walk-ins get none", async () => {
    const grouped = await quote({
      items: [
        { variantId: variantCat, quantity: 1, discount: null },
        { variantId: variantPlain, quantity: 1, discount: null },
      ],
      customerId: customerA,
    });
    assert.equal(grouped.status, 200);
    const body = grouped.json as {
      data: {
        itemsTotal: number;
        finalTotal: number;
        group?: { id: number; name: string; discountAmount: number };
      };
    };
    // 300 total; whole-cart 10% = 30; category 5% on the 100 line = 5 → 35.
    assert.equal(body.data.itemsTotal, 300);
    assert.equal(body.data.group?.discountAmount, 35);
    assert.equal(body.data.group?.name, "Wholesale");
    assert.equal(body.data.finalTotal, 265);

    const groupless = await quote({
      items: [{ variantId: variantCat, quantity: 1, discount: null }],
    });
    const gb = groupless.json as { data: { finalTotal: number; group?: unknown } };
    assert.equal(gb.data.finalTotal, 100);
    assert.equal(gb.data.group, undefined);
  });

  it("stacks the manual cart discount AFTER the group layer", async () => {
    const res = await quote({
      items: [
        { variantId: variantCat, quantity: 1, discount: null },
        { variantId: variantPlain, quantity: 1, discount: null },
      ],
      customerId: customerA,
      cartDiscount: { type: "fixed", value: 20 },
    });
    const body = res.json as { data: { finalTotal: number; cartDiscountAmount: number } };
    // Manual fixed 20 applies on the post-group 265 (still 20 as a fixed
    // amount) → 245.
    assert.equal(body.data.finalTotal, 245);
  });

  it("a coupon stacks with the group discount but still excludes the manual cart discount", async () => {
    const coupon = await api("POST", "/api/coupons", {
      code: "GROUP10",
      discountType: "percentage",
      value: 10,
    });
    assert.equal(coupon.status, 201);

    const both = await quote({
      items: [{ variantId: variantCat, quantity: 1, discount: null }],
      customerId: customerA,
      cartDiscount: { type: "fixed", value: 5 },
      couponCode: "GROUP10",
    });
    assert.equal(
      (both.json as { data: { couponError?: string } }).data.couponError,
      "Use either a cart discount or a coupon — not both.",
    );

    const withCoupon = await quote({
      items: [
        { variantId: variantCat, quantity: 1, discount: null },
        { variantId: variantPlain, quantity: 1, discount: null },
      ],
      customerId: customerA,
      couponCode: "GROUP10",
    });
    const body = withCoupon.json as {
      data: { finalTotal: number; group?: { discountAmount: number }; coupon?: { discountAmount: number } };
    };
    // Group 35 first → 265; coupon 10% of 265 = 26.5 → 238.5.
    assert.equal(body.data.group?.discountAmount, 35);
    assert.equal(body.data.coupon?.discountAmount, 26.5);
    assert.equal(body.data.finalTotal, 238.5);
  });

  it("reduces the VAT base: group discount applies before tax (legacy vatPercent path)", async () => {
    const res = await quote({
      items: [
        { variantId: variantCat, quantity: 1, discount: null },
        { variantId: variantPlain, quantity: 1, discount: null },
      ],
      customerId: customerA,
      vatPercent: 15,
    });
    const body = res.json as { data: { vat: number; finalTotal: number } };
    // (300 − 35) × 15% = 39.75 → total 304.75.
    assert.equal(body.data.vat, 39.75);
    assert.equal(body.data.finalTotal, 304.75);
  });

  it("gates by minimum purchase and active dates", async () => {
    // min purchase far above the cart → the whole-cart row stops applying.
    const minPatch = await api("PATCH", `/api/customer-groups/${wholesaleId}/pricing/${wholeCartPricingId}`, {
      minPurchaseAmount: 1000,
    });
    assert.equal(minPatch.status, 200, JSON.stringify(minPatch.json));
    const gated = await quote({
      items: [{ variantId: variantCat, quantity: 1, discount: null }],
      customerId: customerA,
    });
    assert.equal((gated.json as { data: { group?: { discountAmount: number } } }).data.group?.discountAmount, 5);

    // Restore; then a future validFrom also gates the row out.
    const datePatch = await api("PATCH", `/api/customer-groups/${wholesaleId}/pricing/${wholeCartPricingId}`, {
      minPurchaseAmount: 0,
      validFrom: "2030-01-01",
    });
    assert.equal(datePatch.status, 200, JSON.stringify(datePatch.json));
    const future = await quote({
      items: [{ variantId: variantCat, quantity: 1, discount: null }],
      customerId: customerA,
    });
    assert.equal((future.json as { data: { group?: { discountAmount: number } } }).data.group?.discountAmount, 5);
    const resetPatch = await api("PATCH", `/api/customer-groups/${wholesaleId}/pricing/${wholeCartPricingId}`, {
      validFrom: null,
    });
    assert.equal(resetPatch.status, 200, JSON.stringify(resetPatch.json));
  });

  it("deactivating the group removes the discount everywhere", async () => {
    await api("PATCH", `/api/customer-groups/${wholesaleId}`, { isActive: false });
    const res = await quote({
      items: [
        { variantId: variantCat, quantity: 1, discount: null },
        { variantId: variantPlain, quantity: 1, discount: null },
      ],
      customerId: customerA,
    });
    assert.equal((res.json as { data: { group?: unknown; finalTotal: number } }).data.group, undefined);
    assert.equal((res.json as { data: { finalTotal: number } }).data.finalTotal, 300);
    await api("PATCH", `/api/customer-groups/${wholesaleId}`, { isActive: true });
  });

  // --- createSale: snapshots ------------------------------------------------------

  it("createSale stamps the group snapshot: header group, per-line adjustments, totals", async () => {
    const sale = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: customerA,
      payments: [{ method: "cash", amount: 265, tendered: 265 }],
      discount: null,
      vatPercent: 0,
      items: [
        { variantId: variantCat, quantity: 1, unitPrice: 100, discount: null },
        { variantId: variantPlain, quantity: 1, unitPrice: 200, discount: null },
      ],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.json));
    const saleId = (sale.json as { data: { sale: { id: number } } }).data.sale.id;
    assert.equal((sale.json as { data: { sale: { finalTotal: number } } }).data.sale.finalTotal, 265);

    const rows = await pgClient!.query(
      `SELECT customer_group_id, discount FROM sales WHERE id = $1`,
      [saleId],
    );
    assert.equal(rows.rows[0]!.customer_group_id, wholesaleId);
    assert.equal(Number(rows.rows[0]!.discount), 35);

    const items = await pgClient!.query(
      `SELECT variant_id, price_adjustments FROM sale_items WHERE sale_id = $1 ORDER BY variant_id`,
      [saleId],
    );
    const adjustments = items.rows as {
      variant_id: number;
      price_adjustments: { kind: string; refId: number | null; name: string | null; amount: number }[];
    }[];
    const catRow = adjustments.find((r) => r.variant_id === variantCat)!;
    const plainRow = adjustments.find((r) => r.variant_id === variantPlain)!;
    // Line 1 (100): whole-cart 10 + scoped 5, both attributed to Wholesale.
    assert.equal(catRow.price_adjustments.length, 2);
    assert.deepEqual(
      catRow.price_adjustments.map((a) => a.amount).sort((a, b) => a - b),
      [5, 10],
    );
    assert.ok(catRow.price_adjustments.every((a) => a.kind === "group" && a.name === "Wholesale"));
    // Line 2 (200): whole-cart allocation 20.
    assert.deepEqual(plainRow.price_adjustments.map((a) => a.amount), [20]);

    // Separation invariant: the effective price was never touched.
    const list = await api("GET", "/api/products");
    const grouped = (list.json as { name: string; variants: { sellingPrice: number }[] }[]).find(
      (p) => p.name === "Grouped Product",
    )!;
    assert.equal(grouped.variants[0]!.sellingPrice, 100);
  });

  it("keeps tenants isolated", async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Groups B", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Groups Biz B ${Date.now()}` }),
    });
    const businessIdB = ((await biz.json()) as { business: { id: number } }).business.id;
    const locB = await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenB}`,
        "X-Business-Id": String(businessIdB),
      },
      body: JSON.stringify({ name: "Main Store" }),
    });
    assert.equal(locB.status, 201);

    const groupsB = await fetch(`${baseUrl}/api/customer-groups`, {
      headers: { Authorization: `Bearer ${tokenB}`, "X-Business-Id": String(businessIdB) },
    });
    assert.equal(((await groupsB.json()) as { data: unknown[] }).data.length, 0);

    const foreignQuote = await fetch(`${baseUrl}/api/sales/quote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenB}`,
        "X-Business-Id": String(businessIdB),
      },
      body: JSON.stringify({
        items: [{ variantId: variantCat, quantity: 1, discount: null }],
        cartDiscount: null,
        vatPercent: null,
      }),
    });
    assert.equal(foreignQuote.status, 404);
  });

  it("enforces permissions on group management", async () => {
    const roleRes = await api("POST", "/api/roles", {
      name: `Groups Viewer ${Date.now()}`,
      permissionKeys: ["pricing.view"],
    });
    const roleId = (roleRes.json as { data: { id: number } }).data.id;
    const userRes = await api("POST", "/api/users", {
      fullName: "Groups Viewer",
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

    const read = await fetch(`${baseUrl}/api/customer-groups`, {
      headers: { Authorization: `Bearer ${viewerToken}`, "X-Business-Id": String(businessId) },
    });
    assert.equal(read.status, 200);

    const write = await fetch(`${baseUrl}/api/customer-groups`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerToken}`,
        "X-Business-Id": String(businessId),
      },
      body: JSON.stringify({ name: "Nope" }),
    });
    assert.equal(write.status, 403);
  });
});
