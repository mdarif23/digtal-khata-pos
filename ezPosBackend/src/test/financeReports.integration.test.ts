/**
 * Financial reports, reconciliation & audit trail integration tests
 * (Finance & Growth Stage 8).
 *
 * Seeds a full business day (sale, expense, owner capital, loan with split
 * repayment, depreciating asset, payroll period with a partial payment)
 * and verifies the P&L statement structure, the owner capital reports, the
 * retained-earnings rollforward, payroll/salary-outstanding figures, loan
 * outstanding, budget variance, the balanced transaction report, CSV
 * export, GL-vs-operational reconciliation, the audit trail view and
 * permissions.
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

describe("finance reports integration", { skip: !runIntegration }, () => {
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
      body: JSON.stringify({ name: `Reports Biz ${name}` }),
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
    const email = `${slug}-rep-${stamp}-${Math.floor(Math.random() * 1e6)}@example.test`;
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
  let employeeId = 0;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  before(async () => {
    owner = await createOwner("repowner");
    accountant = await createStaff(owner, "accountant", "Rep Accountant");
    cashier = await createStaff(owner, "cashier", "Rep Cashier");

    const activation = await api(owner, "POST", "/api/finance/activation", {
      accounts: [{ name: "Cash Drawer", type: "cash", openingBalance: 50000 }],
      inventoryValue: 20000,
      ownerCapital: 50000,
    });
    assert.equal(activation.status, 201, JSON.stringify(activation.body));

    const product = await api(owner, "POST", "/api/product", {
      name: `Rep Cola ${stamp}`,
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
          sku: `REP-${stamp}`,
          barcode: null,
          sellingPrice: 100,
          alertQuantity: 5,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `RB-${stamp}`,
          purchasePrice: 40,
          quantity: 500,
          expiryDate: null,
        },
      ],
    });
    assert.equal(product.status, 201);
    const list = await api(owner, "GET", "/api/products");
    const created = (list.body as { name: string; variants: { id: number }[] }[]).find(
      (p) => p.name === `Rep Cola ${stamp}`,
    );
    assert.ok(created);
    variantId = created.variants[0]!.id;

    const ownerProfile = await api(owner, "POST", "/api/finance/owners", {
      name: "Rep Founder",
    });
    const ownerProfileId = ownerProfile.body.id;

    // A full business day of activity.
    assert.equal(
      (await api(owner, "POST", "/api/sales", {
        saleDate: new Date().toISOString(),
        customerId: null,
        payments: [{ method: "cash", amount: 300, tendered: 300 }],
        discount: null,
        vatPercent: null,
        items: [{ variantId, quantity: 3, unitPrice: 100, discount: null }],
      })).status,
      201,
    );
    assert.equal(
      (await api(owner, "POST", "/api/expenses", {
        title: `Rep utilities ${stamp}`,
        amount: 450,
        category_id: null,
        payment_method: "Cash",
        expense_date: today,
      })).status,
      201,
    );
    assert.equal(
      (await api(owner, "POST", "/api/finance/capital-transactions", {
        ownerProfileId,
        type: "investment",
        amount: 5000,
        method: "cash",
      })).status,
      201,
    );
    assert.equal(
      (await api(owner, "POST", "/api/finance/capital-transactions", {
        ownerProfileId,
        type: "withdrawal",
        amount: 1000,
        method: "cash",
      })).status,
      201,
    );
    const loan = await api(owner, "POST", "/api/finance/loans", {
      lenderType: "bank",
      lenderName: "Rep Bank",
      principal: 50000,
      loanDate: today,
      method: "cash",
    });
    assert.equal(loan.status, 201);
    assert.equal(
      (
        await api(owner, "POST", `/api/finance/loans/${loan.body.id}/repayments`, {
          principalAmount: 10000,
          interestAmount: 500,
          method: "cash",
        })
      ).status,
      201,
    );
    const asset = await api(owner, "POST", "/api/finance/assets", {
      name: "Rep Machine",
      category: "equipment",
      acquiredAt: today,
      cost: 12000,
      usefulLifeMonths: 60,
      method: "cash",
    });
    assert.equal(asset.status, 201);
    assert.equal(
      (
        await api(owner, "POST", "/api/finance/assets/depreciation/run", {
          periodMonth: monthStart,
        })
      ).status,
      200,
    );
    const employee = await api(owner, "POST", "/api/payroll/employees", {
      fullName: "Rep Worker",
      salaryStructure: { payType: "monthly", basicAmount: 15000 },
    });
    employeeId = employee.body.id;
    const period = await api(owner, "POST", "/api/payroll/periods", {
      periodStart: monthStart,
      employeeIds: [employeeId],
    });
    assert.equal(period.status, 201, JSON.stringify(period.body));
    assert.equal((await api(owner, "POST", `/api/payroll/periods/${period.body.id}/approve`)).status, 200);
    const recordId = (await api(owner, "GET", `/api/payroll/periods/${period.body.id}`))
      .body.records[0].id;
    assert.equal(
      (
        await api(owner, "POST", `/api/payroll/records/${recordId}/payments`, {
          amount: 5000,
          method: "cash",
        })
      ).status,
      201,
    );

    // Budget for the variance report.
    assert.equal(
      (
        await api(owner, "POST", "/api/expense_budgets", {
          category_id: null,
          month: monthStart,
          amount: 500,
          period_type: "monthly",
        })
      ).status,
      201,
    );
  });

  it("builds the P&L statement with every documented line", async () => {
    const res = await api(owner, "GET", `/api/finance/reports/pnl?from=${today}&to=${today}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.revenue.net, "300.00");
    assert.equal(res.body.cogs, "120.00");
    assert.equal(res.body.grossProfit, "180.00");
    // Opex in TODAY's range: utilities 450 + payroll accrual 15000.
    // (Depreciation posts on the month start, outside this range; interest
    // is reported separately, never inside opex.)
    assert.equal(res.body.operatingExpenses.total, "15450.00");
    assert.equal(res.body.operatingProfit, "-15270.00");
    assert.equal(res.body.interest, "500.00");
    assert.equal(res.body.netProfit, "-15770.00");
  });

  it("reports owner investments and withdrawals with totals", async () => {
    const investments = await api(
      owner,
      "GET",
      `/api/finance/reports/owner-investments?from=${today}&to=${today}`,
    );
    assert.equal(investments.status, 200);
    assert.equal(investments.body.rows.length, 1);
    assert.equal(investments.body.total, "5000.00");

    const withdrawals = await api(
      owner,
      "GET",
      `/api/finance/reports/owner-withdrawals?from=${today}&to=${today}`,
    );
    assert.equal(withdrawals.status, 200);
    assert.equal(withdrawals.body.rows.length, 1);
    assert.equal(withdrawals.body.total, "1000.00");
  });

  it("rolls retained earnings forward", async () => {
    const res = await api(
      owner,
      "GET",
      `/api/finance/reports/retained-earnings?from=${today}&to=${today}`,
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // This activation balances exactly (70000 = 70000) → no 3030 plug. The
    // current month's depreciation (posted on the month start, which is
    // before today) is the only pre-today earning: opening = −200.
    assert.equal(res.body.openingRetainedEarnings, "-200.00");
    assert.equal(res.body.lessProfitDistributions, "0.00");
    assert.equal(res.body.closingRetainedEarnings, "-15970.00");
  });

  it("reports payroll and salary outstanding", async () => {
    const payroll = await api(
      owner,
      "GET",
      `/api/finance/reports/payroll?from=${monthStart}&to=${today}`,
    );
    assert.equal(payroll.status, 200);
    assert.equal(payroll.body.rows.length, 1);
    assert.equal(payroll.body.rows[0].grossAmount, "15000.00");
    assert.equal(payroll.body.rows[0].paidAmount, "5000.00");
    assert.equal(payroll.body.totals.netAmount, "15000.00");

    const outstanding = await api(owner, "GET", "/api/finance/reports/salary-outstanding");
    assert.equal(outstanding.status, 200);
    const row = outstanding.body.rows.find(
      (r: { employeeId: number }) => r.employeeId === employeeId,
    );
    assert.ok(row);
    assert.equal(row.outstanding, "10000.00");
    assert.equal(outstanding.body.totalOutstanding, "10000.00");
  });

  it("reports loan outstanding and budget variance", async () => {
    const loans = await api(owner, "GET", "/api/finance/reports/loan-outstanding");
    assert.equal(loans.status, 200);
    assert.equal(loans.body.totalOutstanding, "40000.00");

    const variance = await api(
      owner,
      "GET",
      `/api/finance/reports/budget-variance?from=${monthStart}&to=${today}`,
    );
    assert.equal(variance.status, 200);
    assert.equal(variance.body.rows.length, 1);
    assert.equal(variance.body.rows[0].actual, "450.00");
    assert.equal(variance.body.rows[0].variance, "50.00");
    assert.equal(variance.body.rows[0].overBudget, false);
  });

  it("reports balanced transactions and supports CSV export", async () => {
    const txns = await api(
      owner,
      "GET",
      `/api/finance/reports/transactions?from=${today}&to=${today}`,
    );
    assert.equal(txns.status, 200);
    assert.equal(txns.body.balanced, true);
    assert.equal(txns.body.totalDebit, txns.body.totalCredit);

    const filtered = await api(
      owner,
      "GET",
      `/api/finance/reports/transactions?from=${today}&to=${today}&source_type=sale`,
    );
    assert.equal(filtered.body.rows.length, 1);
    assert.equal(filtered.body.rows[0].sourceType, "sale");

    // CSV export (raw fetch — the body is text, not JSON).
    const csv = await fetch(
      `${baseUrl}/api/finance/reports/owner-investments?from=${today}&to=${today}&format=csv`,
      {
        headers: {
          Authorization: `Bearer ${owner.token}`,
          "X-Business-Id": String(owner.businessId),
        },
      },
    );
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    const body = await csv.text();
    assert.match(body, /Date,Owner,Amount/);
    assert.match(body, /5000\.00/);
  });

  it("reconciles the GL against the operational ledgers", async () => {
    const res = await api(owner, "GET", "/api/finance/reconciliation");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const byKey = new Map(
      (res.body.checks as { key: string; variance: string; reconciled: boolean }[]).map(
        (c) => [c.key, c],
      ),
    );
    // Inventory: GL 20000 − 120 = 19880 = 497 units × 40.
    assert.equal(byKey.get("inventory")?.variance, "0.00");
    // Salary payable: GL (15000 − 5000) = operational (15000 + 0 − 5000).
    assert.equal(byKey.get("salaryPayable")?.variance, "0.00");
    assert.equal(res.body.allReconciled, true, JSON.stringify(res.body));
  });

  it("exposes the audit trail that was write-only until Stage 8", async () => {
    const res = await api(owner, "GET", "/api/finance/audit-log?action=finance.activated");
    assert.equal(res.status, 200);
    assert.ok(res.body.meta.total >= 1);
    assert.equal(res.body.rows[0].action, "finance.activated");

    const all = await api(owner, "GET", "/api/finance/audit-log?page_size=100");
    assert.ok(all.body.meta.total >= 10);
  });

  it("enforces permissions: accountant reads, cashier is blind", async () => {
    const accountantPnl = await api(
      accountant,
      "GET",
      `/api/finance/reports/pnl?from=${today}&to=${today}`,
    );
    assert.equal(accountantPnl.status, 200);

    const cashierPnl = await api(
      cashier,
      "GET",
      `/api/finance/reports/pnl?from=${today}&to=${today}`,
    );
    assert.equal(cashierPnl.status, 403);

    const cashierRecon = await api(cashier, "GET", "/api/finance/reconciliation");
    assert.equal(cashierRecon.status, 403);
  });
});
