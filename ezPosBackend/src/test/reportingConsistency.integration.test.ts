/**
 * Reporting consistency regression tests (Phase 5 follow-up).
 *
 * They assert the cross-report invariants of the multi-location rollout:
 * dashboard totals match report totals for identical definitions, the
 * location comparison sums to the consolidated reports, register expected
 * cash equals its transaction ledger, refunds never inflate profit, and
 * location scoping cannot be bypassed. Double-guarded like the other
 * suites: runs ONLY with INTEGRATION_TESTS=1 AND DATABASE_URL pointing at
 * ezpos_test (fail-closed).
 *
 * Plain `npm test` NEVER runs this file.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("reporting consistency integration", { skip: !runIntegration }, () => {
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
       -- Test-env normalization: the shared trial plan is unlimited and
       -- full-featured so POS suites exercise POS logic. Plan-limit and
       -- feature gates are covered by dedicated plans in
       -- subscriptionCore.integration.test.ts.
       SET limits = NULL,
           features = '{"multiLocation":true,"advancedReports":true,"storefrontApi":true,"woocommerceIntegration":true,"customStorefront":true,"multipleOnlineStores":true,"advancedWebhooks":true}'::jsonb,
           is_active = true`,
    );
    await client.end();

    await ensureRbacSeed();

    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(() => {
    server?.close();
  });

  const uniqueEmail = () =>
    `cons-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

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
    locationId?: number,
  ): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.token}`,
      "X-Business-Id": String(ctx.businessId),
    };
    if (locationId !== undefined) {
      headers["X-Location-Id"] = String(locationId);
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
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

  const RANGE = "startDate=2020-01-01&endDate=2030-12-31";

  const stamp = Date.now();
  let owner: Ctx;
  let locationA = 0;
  let locationB = 0;
  let variantId = 0;

  async function makeSale(
    locationId: number,
    quantity: number,
    discount: { type: "percentage" | "fixed"; value: number } | null,
  ): Promise<void> {
    const gross = quantity * 100;
    const payable =
      discount?.type === "percentage"
        ? gross - (gross * discount.value) / 100
        : discount?.type === "fixed"
          ? gross - discount.value
          : gross;
    const res = await api(
      owner,
      "POST",
      "/api/sales",
      {
        saleDate: new Date().toISOString(),
        customerId: null,
        payments: [{ method: "cash", amount: payable, tendered: payable }],
        discount,
        vatPercent: null,
        items: [{ variantId, quantity, unitPrice: 100, discount: null }],
      },
      locationId,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  before(async () => {
    owner = await registerAndCreateBusiness(
      `cons-owner-${stamp}@example.test`,
      `Consistency Biz ${stamp}`,
    );
    const a = await api(owner, "POST", "/api/locations", { name: `Cons A ${stamp}` });
    locationA = payload<{ data: { id: number } }>(a).data.id;
    const b = await api(owner, "POST", "/api/locations", { name: `Cons B ${stamp}` });
    locationB = payload<{ data: { id: number } }>(b).data.id;

    // Product: cost 40, price 100, opening stock 1000 at A (default).
    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Piece ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ data: { value: number } }>(unitRes).data.value;
    const product = await api(owner, "POST", "/api/product", {
      name: `Consistency Cola ${stamp}`,
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
          sku: `CONS-${stamp}`,
          barcode: null,
          sellingPrice: 100,
          alertQuantity: 5,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `BATCH-${stamp}`,
          purchasePrice: 40,
          quantity: 1000,
          expiryDate: null,
        },
      ],
    });
    assert.equal(product.status, 201);
    const list = await api(owner, "GET", "/api/products");
    const created = (
      list.body as { name: string; variants: { id: number }[] }[]
    ).find((p) => p.name === `Consistency Cola ${stamp}`);
    assert.ok(created);
    variantId = created.variants[0]!.id;

    // Stock at B for the second location's sale.
    const transfer = await api(owner, "POST", "/api/stock-transfers", {
      fromLocationId: locationA,
      toLocationId: locationB,
      items: [{ variantId, quantity: 200 }],
    });
    const transferId = payload<{ data: { id: number } }>(transfer).data.id;
    await api(owner, "POST", `/api/stock-transfers/${transferId}/ship`);
    const received = await api(
      owner,
      "POST",
      `/api/stock-transfers/${transferId}/receive`,
      {},
    );
    assert.equal(received.status, 200);

    // Register at A; owner opens with 1000.
    const register = await api(
      owner,
      "POST",
      "/api/registers",
      { name: `Cons Counter ${stamp}` },
      locationA,
    );
    const registerId = payload<{ data: { id: number } }>(register).data.id;
    const opened = await api(
      owner,
      "POST",
      `/api/registers/${registerId}/open`,
      { openingCash: 1000 },
      locationA,
    );
    assert.equal(opened.status, 201, JSON.stringify(opened.body));

    // Sales:
    // S1 A 5×100 = 500 (cost 200) — plain cash
    // S2 B 3×100 = 300 (cost 120) — plain cash
    // S3 A 2×100 with 10% cart discount = 180 payable (cost 80)
    // S4 A 1×100 = 100 (cost 40) — refunded below
    await makeSale(locationA, 5, null);
    await makeSale(locationB, 3, null);
    await makeSale(locationA, 2, { type: "percentage", value: 10 });
    await makeSale(locationA, 1, null);

    // S3 refunded fully, restocked. S4 refunded fully, NOT restocked
    // (inspection). Refund money: 180 (restocked) and 100 (not restocked).
    const sold = await api(owner, "GET", "/api/sold_products");
    assert.equal(sold.status, 200);
    const rows = sold.body as { saleId: number; quantity: number }[];
    const byQty = (quantity: number) =>
      rows.filter((r) => Number(r.quantity) === quantity);
    // Identify S3/S4 by their invoice totals via receipt lookups instead of
    // guessing: refund the sale whose final total is 180, and the 100 one.
    const saleIds = [...new Set(rows.map((r) => Number(r.saleId)))];
    const totals = new Map<number, number>();
    for (const saleId of saleIds) {
      const receipt = await api(owner, "GET", `/api/sales/${saleId}/receipt`);
      assert.equal(receipt.status, 200);
      const body = receipt.body as { finalTotal: number };
      totals.set(saleId, Number(body.finalTotal));
    }
    const s3 = saleIds.find((id) => totals.get(id) === 180);
    const s4 = saleIds.find((id) => totals.get(id) === 100);
    assert.ok(s3, "discounted sale (180) not found");
    assert.ok(s4, "plain sale (100) not found");

    const refundS3 = await api(
      owner,
      "POST",
      `/api/sold_products/refunds_all/${s3}`,
      { reason: "customer_request", disposition: "restock" },
    );
    assert.equal(refundS3.status, 200, JSON.stringify(refundS3.body));
    const refundS4 = await api(
      owner,
      "POST",
      `/api/sold_products/refunds_all/${s4}`,
      { reason: "damaged", disposition: "inspection" },
    );
    assert.equal(refundS4.status, 200, JSON.stringify(refundS4.body));

    // Manual cash in 100 to the open session.
    const current = await api(owner, "GET", "/api/sessions/current");
    const sessionId = payload<{ data: { id: number } }>(current).data.id;
    const cashIn = await api(
      owner,
      "POST",
      `/api/sessions/${sessionId}/cash-movement`,
      { type: "cash_in", amount: 100, note: "change fund" },
    );
    assert.equal(cashIn.status, 200);
    void byQty;
  });

  async function registerAndCreateBusiness(
    email: string,
    businessName: string,
  ): Promise<Ctx> {
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Consistency Test",
        email,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: businessName }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business: { id: number } };
    return {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
      email,
    };
  }

  it("dashboard net sales equal the sales summary report net sales", async () => {
    const dashboard = await api(
      owner,
      "GET",
      "/api/dashboard_summary?period=365d",
    );
    assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body).slice(0, 300));
    const currentNetSales = Number(
      (dashboard.body as { salesSummary: { current_net_sales: string }[] })
        .salesSummary[0]!.current_net_sales,
    );

    const report = await api(
      owner,
      "GET",
      `/api/reports/sales/summary?${RANGE}`,
    );
    assert.equal(report.status, 200, "summary status");
    const reportData = (
      report.body as {
        data?: { totals?: { total_net_sales?: number } };
      }
    ).data;
    const totalNetSales = Number(reportData?.totals?.total_net_sales ?? -1);

    // Both cover all sales created in this suite; equal definitions must
    // produce equal numbers (1080 gross − 280 refunds = 800).
    assert.equal(totalNetSales, 800);
    assert.equal(currentNetSales, 800);
  });

  it("refunds do not inflate profit (discounted restock + non-restock)", async () => {
    // Item profit: S1 300 + S2 180 + S3 120 + S4 60 = 660.
    // Refund money: 180 + 100 = 280. Restocked cost back: 80 (S3 only).
    // Consistent profit: 660 − 280 + 80 = 460. (The old formula would have
    // reported 660 — refunds inflating profit.)
    const profit = await api(
      owner,
      "GET",
      `/api/reports/financial/profit?${RANGE}`,
    );
    assert.equal(profit.status, 200);
    const totals = payload<{
      data: {
        totals: {
          totalGrossProfit: number;
          totalRefundMoney: number;
          totalRestockedCost: number;
          adjustedGrossProfit: number;
        };
      };
    }>(profit).data.totals;
    assert.equal(Number(totals.totalGrossProfit), 660);
    assert.equal(Number(totals.totalRefundMoney), 280);
    assert.equal(Number(totals.totalRestockedCost), 80);
    assert.equal(Number(totals.adjustedGrossProfit), 460);

    // Dashboard net profit = profit report − expenses (no expenses here).
    const dashboard = await api(owner, "GET", "/api/dashboard_summary?period=365d");
    const netProfit = Number(
      (dashboard.body as { netProfit: { current_net_profit: string }[] })
        .netProfit[0]!.current_net_profit,
    );
    const expenses = Number(
      (dashboard.body as { expensesSummary: { current_expenses: string }[] })
        .expensesSummary[0]!.current_expenses,
    );
    assert.equal(netProfit + expenses, 460);
  });

  it("location comparison totals match the consolidated reports", async () => {
    const comparison = await api(
      owner,
      "GET",
      `/api/reports/locations/comparison?${RANGE}`,
    );
    assert.equal(comparison.status, 200, JSON.stringify(comparison.body).slice(0, 300));
    const data = (
      comparison.body as {
        data?: {
          rows: { locationId: number; net: number }[];
          totals: { net: number; invoiceCount: number };
        };
      }
    ).data!;

    const report = await api(
      owner,
      "GET",
      `/api/reports/sales/summary?${RANGE}`,
    );
    const totalNetSales = Number(
      (
        report.body as { data?: { totals?: { total_net_sales?: number } } }
      ).data?.totals?.total_net_sales ?? -1,
    );

    assert.equal(Number(data.totals.net), totalNetSales);
    const rowA = data.rows.find((r) => r.locationId === locationA);
    const rowB = data.rows.find((r) => r.locationId === locationB);
    // A: 780 gross − 280 refunds = 500; B: 300.
    assert.equal(rowA!.net, 500);
    assert.equal(rowB!.net, 300);
  });

  it("register expected cash matches its transaction ledger", async () => {
    // Owner's session: opening 1000 + cash sales (500 + 180 + 100 = 780)
    // + cash in 100 − cash refunds (180 + 100 = 280, both counter payouts
    // recorded by the refund path) = 1600 expected. The B-location sale
    // (300) is NOT in this drawer.
    const current = await api(owner, "GET", "/api/sessions/current");
    const session = payload<{ data: { id: number; expectedCash: number } }>(
      current,
    ).data;
    assert.equal(session.expectedCash, 1600);

    const closed = await api(owner, "POST", `/api/sessions/${session.id}/close`, {
      countedCash: 1590,
    });
    assert.equal(closed.status, 200);
    assert.equal(
      payload<{ data: { difference: number } }>(closed).data.difference,
      -10,
    );

    // Z-Report: the session row carries the same ledger numbers.
    const zreport = await api(
      owner,
      "GET",
      `/api/reports/financial/register-close?${RANGE}`,
    );
    assert.equal(zreport.status, 200);
    const zData = payload<{
      data: {
        sessions: {
          sessionId: number;
          cashSales: number;
          openingCash: number;
          expectedCash: number;
          countedCash: number;
          difference: number;
          nonCashSales: number;
          cashRefunds: number;
        }[];
        totals: { difference: number };
      };
    }>(zreport).data;
    const zSession = zData.sessions.find(
      (s) => s.sessionId === session.id,
    );
    assert.ok(zSession);
    assert.equal(zSession.cashSales, 780);
    assert.equal(zSession.openingCash, 1000);
    assert.equal(zSession.cashRefunds, 280);
    assert.equal(zSession.expectedCash, 1600);
    assert.equal(zSession.countedCash, 1590);
    assert.equal(zSession.difference, -10);
    assert.equal(zSession.nonCashSales, 0);
  });

  it("historical transactions are unchanged by refunds", async () => {
    const sold = await api(owner, "GET", "/api/sold_products");
    const rows = sold.body as { saleId: number; quantity: number }[];
    const saleIds = [...new Set(rows.map((r) => Number(r.saleId)))];
    const totals: number[] = [];
    for (const saleId of saleIds) {
      const receipt = await api(owner, "GET", `/api/sales/${saleId}/receipt`);
      totals.push(Number((receipt.body as { finalTotal: number }).finalTotal));
    }
    totals.sort((x, y) => x - y);
    assert.deepEqual(totals, [100, 180, 300, 500]);
  });

  it("a cashier cannot scope the dashboard or reports to another location", async () => {
    const roles = await api(owner, "GET", "/api/roles");
    const managerRole = payload<{ data: { id: number; slug: string }[] }>(roles).data.find(
      (r) => r.slug === "manager",
    );
    assert.ok(managerRole, "manager role missing");
    const email = `cons-manager-${stamp}@example.test`;
    const created = await api(owner, "POST", "/api/users", {
      fullName: "Cons Manager",
      email,
      password: "strong-password-123",
      roleIds: [managerRole.id],
      locationIds: [locationA],
    });
    assert.equal(created.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    const cashier: Ctx = {
      token: ((await login.json()) as { accessToken: string }).accessToken,
      businessId: owner.businessId,
      userId: payload<{ data: { userId: number } }>(created).data.userId,
      email,
    };

    // Own location: allowed.
    const own = await api(
      cashier,
      "GET",
      `/api/dashboard_summary?period=365d&locationId=${locationA}`,
    );
    assert.equal(own.status, 200);

    // Other location: 403 on dashboard AND reports.
    const foreignDashboard = await api(
      cashier,
      "GET",
      `/api/dashboard_summary?period=365d&locationId=${locationB}`,
    );
    assert.equal(foreignDashboard.status, 403);
    const foreignReport = await api(
      cashier,
      "GET",
      `/api/reports/sales/summary?${RANGE}&locationId=${locationB}`,
    );
    assert.equal(foreignReport.status, 403);
  });

  it("existing reports keep working without a location parameter", async () => {
    for (const path of [
      `/api/reports/sales/summary?${RANGE}`,
      `/api/reports/financial/profit?${RANGE}`,
      `/api/reports/financial/expenses?${RANGE}`,
      `/api/reports/inventory/stock`,
      `/api/reports/purchases/summary?${RANGE}`,
      `/api/dashboard_summary?period=365d`,
    ]) {
      const res = await api(owner, "GET", path);
      assert.equal(res.status, 200, `${path} -> ${res.status}`);
    }
  });
});
