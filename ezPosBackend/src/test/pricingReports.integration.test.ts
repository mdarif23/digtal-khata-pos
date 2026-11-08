/**
 * Pricing attribution reports integration tests — Phase 7 (report §18 gate:
 * reports tests). Covers: group profitability from the sales.customer_group_id
 * snapshot + sale_items.price_adjustments (group/promotion layers attributed,
 * walk-in bucket, snapshot independence from live membership changes),
 * promotion performance per promotion (incl. the removed-promotion fallback),
 * and the pre-existing profit report regression (sale snapshots unchanged by
 * the pricing program).
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("pricing reports integration", { skip: !runIntegration }, () => {
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
    `pricing-reports-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let locationId = 0;
  let variantA = 0; // price 100, cost 50
  let variantB = 0; // price 200, cost 100
  let groupId = 0;
  let customerMember = 0;
  let promoWholeCartId = 0;
  let memberSaleId = 0;
  let walkinSaleId = 0;

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

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Reports Owner", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Reports Biz ${Date.now()}` }),
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

    const variants: number[] = [];
    for (const spec of [
      { name: "Report Product A", price: 100, cost: 50 },
      { name: "Report Product B", price: 200, cost: 100 },
    ]) {
      const unit = await api("POST", "/api/product/unit", {
        unitName: `${spec.name} Unit ${Date.now()}`,
        abbreviation: "ru",
      });
      const unitId = (unit.json as { data: { value: number } }).data.value;
      const prod = await api("POST", "/api/product", {
        name: spec.name,
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
      variants.push(
        (detail.json as { variants: { id: number }[] }).variants[0]!.id,
      );
    }
    variantA = variants[0]!;
    variantB = variants[1]!;

    const group = await api("POST", "/api/customer-groups", { name: "Club" });
    groupId = group.json.data.id;
    const pricing = await api("POST", `/api/customer-groups/${groupId}/pricing`, {
      discountType: "percentage",
      discountValue: 10,
    });
    assert.equal(pricing.status, 201);
    const cust = await api("POST", "/api/customers", {
      name: "Club Member",
      phone: "1733000001",
    });
    customerMember = cust.json.id;
    await api("PUT", `/api/customer-groups/${groupId}/members`, {
      customerIds: [customerMember],
    });

    promoWholeCartId = (
      (
        await api("POST", "/api/promotions", {
          name: "Report Promo",
          discountType: "fixed",
          discountValue: 15,
          canStackWithGroupDiscount: true,
        })
      ).json as { data: { id: number } }
    ).data.id;

    // Member sale: 100 + 200 = 300 → group 10% = 30 → promo fixed 15 on the
    // post-group 270 → total 255. Costs 50 + 100 = 150 → profit 105.
    const memberSale = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: customerMember,
      payments: [{ method: "cash", amount: 255, tendered: 255 }],
      discount: null,
      vatPercent: 0,
      items: [
        { variantId: variantA, quantity: 1, unitPrice: 100, discount: null },
        { variantId: variantB, quantity: 1, unitPrice: 200, discount: null },
      ],
    });
    assert.equal(memberSale.status, 201, JSON.stringify(memberSale.json));
    memberSaleId = (memberSale.json as { data: { sale: { id: number } } }).data.sale.id;

    // Walk-in sale at list prices: 100, cost 50 → profit 50.
    const walkinSale = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 100, tendered: 100 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: variantA, quantity: 1, unitPrice: 100, discount: null }],
    });
    assert.equal(walkinSale.status, 201, JSON.stringify(walkinSale.json));
    walkinSaleId = (walkinSale.json as { data: { sale: { id: number } } }).data.sale.id;
  });

  it("aggregates group profitability from the snapshots", async () => {
    const res = await api(
      "GET",
      `/api/reports/pricing/group-profitability?period=custom&startDate=${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}&endDate=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`,
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const rows = (res.json as { data: { rows: {
      groupId: number | null; groupName: string; salesCount: number;
      grossSales: number; groupDiscounts: number; promotionDiscounts: number;
      netRevenue: number; netProfit: number; marginPercent: number;
    }[] } }).data.rows;

    const club = rows.find((r) => r.groupId === groupId)!;
    assert.ok(club, "club row present");
    assert.equal(club.salesCount, 1);
    assert.equal(club.grossSales, 300);
    assert.equal(club.groupDiscounts, 30);
    assert.equal(club.promotionDiscounts, 15);
    assert.equal(club.netRevenue, 255);
    assert.equal(club.netProfit, 105);
    assert.equal(club.marginPercent, 41.18);

    const walkin = rows.find((r) => r.groupId === null)!;
    assert.ok(walkin, "walk-in row present");
    assert.equal(walkin.groupName, "No group");
    assert.equal(walkin.salesCount, 1);
    assert.equal(walkin.netProfit, 50);
  });

  it("keeps group attribution on the snapshot after membership changes", async () => {
    // Move the customer out of the club: historical sales keep their group.
    await api("DELETE", `/api/customer-groups/${groupId}/members/${customerMember}`);
    const res = await api(
      "GET",
      `/api/reports/pricing/group-profitability?period=custom&startDate=${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}&endDate=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`,
    );
    const club = (res.json as { data: { rows: { groupId: number | null; salesCount: number }[] } })
      .data.rows.find((r) => r.groupId === groupId)!;
    assert.equal(club.salesCount, 1);
  });

  it("aggregates promotion performance and survives promotion deletion", async () => {
    const res = await api(
      "GET",
      `/api/reports/pricing/promotion-performance?period=custom&startDate=${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}&endDate=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`,
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const rows = (res.json as { data: { rows: { promotionId: number; promotionName: string; salesCount: number; totalDiscount: number }[] } }).data.rows;
    const row = rows.find((r) => r.promotionId === promoWholeCartId)!;
    assert.ok(row);
    assert.equal(row.promotionName, "Report Promo");
    assert.equal(row.salesCount, 1);
    assert.equal(row.totalDiscount, 15);

    // Delete the promotion: the report keeps the attribution content.
    await api("DELETE", `/api/promotions/${promoWholeCartId}`);
    const afterDelete = await api(
      "GET",
      `/api/reports/pricing/promotion-performance?period=custom&startDate=${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}&endDate=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`,
    );
    const orphan = (afterDelete.json as { data: { rows: { promotionId: number; promotionName: string; totalDiscount: number }[] } })
      .data.rows.find((r) => r.promotionId === promoWholeCartId)!;
    assert.ok(orphan);
    assert.equal(orphan.promotionName, `Removed promotion #${promoWholeCartId}`);
    assert.equal(orphan.totalDiscount, 15);
  });

  it("keeps the pre-existing profit report on sale snapshots (regression)", async () => {
    const res = await api(
      "GET",
      `/api/reports/financial/profit?period=custom&startDate=${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}&endDate=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`,
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    // The profit formula reads sale_items snapshots (selling_price −
    // cost_at_sale) — the automatic discount layers live in
    // price_adjustments and NEVER rewrite those snapshots. Both sales:
    // (100−50) + (200−100) = 150 member + 50 walk-in = 200 gross profit.
    const data = res.json.data as {
      totals?: { grossProfit?: number };
      summary?: { grossProfit?: number };
      grossProfit?: number;
    };
    const grossProfit =
      data.totals?.grossProfit ?? data.summary?.grossProfit ?? data.grossProfit;
    assert.equal(Number(grossProfit), 200);
    void memberSaleId;
    void walkinSaleId;
  });
});
