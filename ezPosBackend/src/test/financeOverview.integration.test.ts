/**
 * Financial overview, cash flow & growth analytics integration tests
 * (Finance & Growth Stage 6).
 *
 * Covers: the documented overview metrics (P&L block, GL balances, owner
 * block, batch-valuation cross-check), the direct-method cash flow with its
 * defining invariant (net movement must equal the change in cash balances,
 * classified by category and source), growth comparisons with the zero-
 * denominator policy, and permission enforcement.
 *
 * Double-guarded: runs ONLY with INTEGRATION_TESTS=1 AND DATABASE_URL
 * pointing at ezpos_test (fail-closed).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("finance overview integration", { skip: !runIntegration }, () => {
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
    await ensureRbacSeed();

    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(() => {
    server?.close();
  });

  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  interface Ctx { token: string; businessId: number; userId: number; email: string }

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
    const resBody = await res.json().catch(() => null);
    return { status: res.status, body: resBody };
  }

  async function createOwner(name: string): Promise<Ctx> {
    const email = `${name}-${stamp}@example.test`;
    await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Test Owner", email, password: "strong-password-123" }),
    });
    const login = await (await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    })).json() as { accessToken: string; user: { id: number } };
    const biz = await (await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${login.accessToken}`,
      },
      body: JSON.stringify({ name: `Overview Biz ${name}` }),
    })).json() as { business: { id: number } };
    const ctx: Ctx = {
      token: login.accessToken,
      businessId: biz.business.id,
      userId: login.user.id,
      email,
    };
    await api(ctx, "POST", "/api/locations", { name: "Main Store" });
    return ctx;
  }

  async function createStaff(owner: Ctx, slug: string, name: string): Promise<Ctx> {
    const roles = await api(owner, "GET", "/api/roles");
    const role = (roles.body.data as { id: number; slug: string }[]).find(
      (r) => r.slug === slug,
    );
    assert.ok(role);
    const locations = await api(owner, "GET", "/api/locations");
    const locationId = (locations.body.data as { id: number }[])[0]!.id;
    const email = `${slug}-ov-${stamp}-${Math.floor(Math.random() * 1e6)}@example.test`;
    const created = await api(owner, "POST", "/api/users", {
      fullName: name,
      email,
      password: "strong-password-123",
      roleIds: [role.id],
      locationIds: [locationId],
    });
    assert.equal(created.status, 201);
    const login = await (await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    })).json() as { accessToken: string; user: { id: number } };
    return {
      token: login.accessToken,
      businessId: owner.businessId,
      userId: login.user.id,
      email,
    };
  }

  let owner: Ctx;
  let accountant: Ctx;
  let cashier: Ctx;
  let variantId = 0;
  const today = new Date().toISOString().slice(0, 10);

  before(async () => {
    owner = await createOwner("ovowner");
    accountant = await createStaff(owner, "accountant", "Ov Accountant");
    cashier = await createStaff(owner, "cashier", "Ov Cashier");
    const activation = await api(owner, "POST", "/api/finance/activation", {
      accounts: [{ name: "Cash Drawer", type: "cash", openingBalance: 10000 }],
      inventoryValue: 20000,
      ownerCapital: 10000,
    });
    assert.equal(activation.status, 201, JSON.stringify(activation.body));

    const product = await api(owner, "POST", "/api/product", {
      name: `Ov Cola ${stamp}`,
      categoryId: null,
      brandId: null,
      unitId: (
        await api(owner, "POST", "/api/product/unit", {
          unitName: `Pcs ${stamp}`,
          abbreviation: "Pcs",
        })
      ).body.data.value,
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
          sku: `OV-${stamp}`,
          barcode: null,
          sellingPrice: 100,
          alertQuantity: 5,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `OVB-${stamp}`,
          purchasePrice: 40,
          quantity: 500,
          expiryDate: null,
        },
      ],
    });
    assert.equal(product.status, 201);
    const list = await api(owner, "GET", "/api/products");
    const created = (list.body as { name: string; variants: { id: number }[] }[]).find(
      (p) => p.name === `Ov Cola ${stamp}`,
    );
    assert.ok(created);
    variantId = created.variants[0]!.id;

    // Seed a full business day: investment, withdrawal, sale, expense.
    const investment = await api(owner, "POST", "/api/finance/capital-transactions", {
      ownerProfileId: (
        await api(owner, "POST", "/api/finance/owners", { name: "Ov Founder" })
      ).body.id,
      type: "investment",
      amount: 5000,
      method: "cash",
    });
    assert.equal(investment.status, 201, JSON.stringify(investment.body));
    const withdrawal = await api(owner, "POST", "/api/finance/capital-transactions", {
      ownerProfileId: (
        await api(owner, "GET", "/api/finance/owners")
      ).body.rows[0].id,
      type: "withdrawal",
      amount: 1000,
      method: "cash",
    });
    assert.equal(withdrawal.status, 201, JSON.stringify(withdrawal.body));
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 300, tendered: 300 }],
      discount: null,
      vatPercent: null,
      items: [{ variantId, quantity: 3, unitPrice: 100, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const expense = await api(owner, "POST", "/api/expenses", {
      title: `Ov utilities ${stamp}`,
      amount: 50,
      category_id: null,
      payment_method: "Cash",
      expense_date: today,
    });
    assert.equal(expense.status, 201, JSON.stringify(expense.body));
  });

  it("builds the financial overview from the ledger with documented metrics", async () => {
    const res = await api(
      owner,
      "GET",
      `/api/finance/overview?from=${today}&to=${today}`,
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // P&L block for the day.
    assert.equal(res.body.profit.netRevenue, "300.00");
    assert.equal(res.body.profit.cogs, "120.00");
    assert.equal(res.body.profit.grossProfit, "180.00");
    assert.equal(res.body.profit.operatingExpenses, "50.00");
    assert.equal(res.body.profit.netProfit, "130.00");

    // Balances: 10000 opening + 5000 investment − 1000 withdrawal + 300 − 50.
    assert.equal(res.body.balances.cash, "14250.00");
    // GL inventory equals the operational batch valuation.
    assert.equal(res.body.balances.inventory, "19880.00");
    assert.equal(res.body.inventoryBatchValuation, "19880.00");
    assert.equal(res.body.balances.ownerContributions, "15000.00");
    assert.equal(res.body.balances.ownerDrawings, "1000.00");
    // The opening inventory (20000) balances the activation entry as the
    // pre-ledger retained-earnings plug.
    assert.equal(res.body.balances.retainedEarnings, "20000.00");
    assert.equal(res.body.balances.accountsReceivable, "0.00");
    assert.equal(res.body.balances.accountsPayable, "0.00");

    // Owner block (transaction aggregates).
    assert.equal(res.body.owner.contributed, "5000.00");
    assert.equal(res.body.owner.returned, "1000.00");
    assert.equal(res.body.owner.position, "4000.00");
  });

  it("builds the direct-method cash flow that reconciles with cash balances", async () => {
    const res = await api(
      owner,
      "GET",
      `/api/finance/cash-flow?from=${today}&to=${today}`,
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // The range includes TODAY's activation entry (cash opening 10000),
    // so inflows = 10000 (opening) + 5000 (investment) + 300 (sale).
    assert.equal(res.body.totals.inflow, "15300.00");
    assert.equal(res.body.totals.outflow, "1050.00");
    assert.equal(res.body.totals.net, "14250.00");

    // The opening entry carries cashFlowCategory 'none' — only real
    // business movements classify into operating/financing.
    assert.equal(res.body.byCategory.operating.inflow, "300.00");
    assert.equal(res.body.byCategory.operating.outflow, "50.00");
    assert.equal(res.body.byCategory.financing.inflow, "5000.00");
    assert.equal(res.body.byCategory.financing.outflow, "1000.00");
    assert.equal(res.body.byCategory.investing.inflow, "0.00");

    const bySource = new Map(
      (
        res.body.bySource as {
          sourceType: string;
          inflow: string;
          outflow: string;
        }[]
      ).map((s) => [s.sourceType, s]),
    );
    assert.equal(bySource.get("owner_capital")?.inflow, "5000.00");
    assert.equal(bySource.get("owner_capital")?.outflow, "1000.00");
    assert.equal(bySource.get("sale")?.inflow, "300.00");
    // A fully-paid expense settles inside its own accrual entry
    // (sourceType 'expense'); later settlements use 'expense_payment'.
    assert.equal(bySource.get("expense")?.outflow, "50.00");

    // THE cash-flow invariant: net movement === closing − opening cash,
    // and it must equal the classified total.
    assert.equal(res.body.reconciliation.openingBalance, "0.00");
    assert.equal(res.body.reconciliation.closingBalance, "14250.00");
    assert.equal(res.body.reconciliation.netMovement, "14250.00");
    assert.equal(res.body.reconciliation.netMovement, res.body.totals.net);

    const series = res.body.series as { date: string; net: string }[];
    assert.equal(series.length, 1);
    assert.equal(series[0]!.date, today);
    assert.equal(series[0]!.net, "14250.00");
  });

  it("compares periods with the zero-denominator policy", async () => {
    const res = await api(owner, "GET", "/api/finance/growth?period=this_month");
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(res.body.period, "this_month");
    assert.equal(res.body.current.netRevenue, "300.00");
    assert.equal(res.body.current.netProfit, "130.00");
    assert.equal(res.body.current.grossMarginPercent, 60);
    assert.equal(res.body.current.salesCount, 1);
    assert.equal(res.body.current.averageOrderValue, "300.00");
    // The previous period had no activity → percentages are null
    // (zero denominator = insufficient data, never a fabricated number).
    assert.equal(res.body.previous.netRevenue, "0.00");
    assert.equal(res.body.changes.netRevenuePercent, null);
    assert.equal(res.body.changes.netProfitPercent, null);
    assert.ok(Array.isArray(res.body.insights));
  });

  it("accepts custom ranges and rejects invalid input", async () => {
    const ok = await api(
      owner,
      "GET",
      `/api/finance/growth?from=${today}&to=${today}`,
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.body.period, "custom");

    const bad = await api(owner, "GET", "/api/finance/growth");
    assert.equal(bad.status, 400);

    const badRange = await api(
      owner,
      "GET",
      `/api/finance/overview?from=${today}&to=2020-01-01`,
    );
    assert.equal(badRange.status, 400);
  });

  it("enforces permissions: accountant can read, cashier cannot", async () => {
    const accountantView = await api(
      accountant,
      "GET",
      `/api/finance/overview?from=${today}&to=${today}`,
    );
    assert.equal(accountantView.status, 200);

    const accountantGrowth = await api(owner, "GET", "/api/finance/growth?period=this_month");
    assert.equal(accountantGrowth.status, 200);

    const cashierView = await api(
      cashier,
      "GET",
      `/api/finance/overview?from=${today}&to=${today}`,
    );
    assert.equal(cashierView.status, 403);

    const cashierGrowth = await api(cashier, "GET", "/api/finance/growth?period=this_month");
    assert.equal(cashierGrowth.status, 403);
  });

  it("keeps assets = liabilities + equity after every scenario", async () => {
    const tb = await api(owner, "GET", "/api/finance/trial-balance");
    const byType = new Map(
      (tb.body.sections as { type: string; totalDebit: string; totalCredit: string }[]).map(
        (s) => [s.type, { debit: Number(s.totalDebit), credit: Number(s.totalCredit) }],
      ),
    );
    const zero = { debit: 0, credit: 0 };
    const assets = byType.get("asset") ?? zero;
    const liabilities = byType.get("liability") ?? zero;
    const equity = byType.get("equity") ?? zero;
    const revenue = byType.get("revenue") ?? zero;
    const expenses = byType.get("expense") ?? zero;
    const lhs = assets.debit - assets.credit;
    const rhs =
      (liabilities.credit - liabilities.debit) +
      (equity.credit - equity.debit) +
      (revenue.credit - revenue.debit) -
      (expenses.debit - expenses.credit);
    assert.equal(lhs, rhs, `A=${lhs} must equal L+E+R−X=${rhs}`);
  });
});
