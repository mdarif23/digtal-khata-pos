/**
 * Budgets (period types + alerts), loans, assets & depreciation, and the
 * balance sheet — integration tests (Finance & Growth Stage 7).
 *
 * Covers: monthly vs quarterly budgets with period-aware usage and alert
 * flags, the threshold alert sweep, loans (disbursement → GL 2080, split
 * principal/interest repayments → 2080/5090, auto-close, over-repayment
 * guard), straight-line depreciation (idempotent per month, contra-asset
 * 1090), the balance sheet A = L + E identity and net worth, and
 * permission enforcement.
 *
 * Double-guarded: runs ONLY with INTEGRATION_TESTS=1 AND DATABASE_URL
 * pointing at ezpos_test (fail-closed).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("finance tools integration", { skip: !runIntegration }, () => {
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
      body: JSON.stringify({ name: `Tools Biz ${name}` }),
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
    const email = `${slug}-tools-${stamp}-${Math.floor(Math.random() * 1e6)}@example.test`;
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

  async function balances(): Promise<Map<string, number>> {
    const res = await api(owner, "GET", "/api/finance/accounts/balances");
    return new Map(
      (res.body.rows as { code: string; balance: string }[]).map((r) => [
        r.code,
        Number(r.balance),
      ]),
    );
  }

  let owner: Ctx;
  let accountant: Ctx;
  let cashier: Ctx;
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const today = now.toISOString().slice(0, 10);
  const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3 + 1;
  const quarterStart = `${now.getFullYear()}-${String(quarterStartMonth).padStart(2, "0")}-01`;
  const midQuarterMonth =
    now.getMonth() % 3 !== 0
      ? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`
      : null;

  before(async () => {
    owner = await createOwner("toolsowner");
    accountant = await createStaff(owner, "accountant", "Tools Accountant");
    cashier = await createStaff(owner, "cashier", "Tools Cashier");
    const activation = await api(owner, "POST", "/api/finance/activation", {
      accounts: [{ name: "Cash Drawer", type: "cash", openingBalance: 50000 }],
      ownerCapital: 50000,
    });
    assert.equal(activation.status, 201, JSON.stringify(activation.body));
  });

  it("supports monthly and quarterly budgets with period-aware usage", async () => {
    const monthly = await api(owner, "POST", "/api/expense_budgets", {
      category_id: null,
      month: monthStart,
      amount: 500,
      period_type: "monthly",
      warning_threshold_percent: 80,
    });
    assert.equal(monthly.status, 201, JSON.stringify(monthly.body));

    const quarterly = await api(owner, "POST", "/api/expense_budgets", {
      category_id: null,
      month: quarterStart,
      amount: 3000,
      period_type: "quarterly",
    });
    assert.equal(quarterly.status, 201, JSON.stringify(quarterly.body));

    // Mid-quarter month is rejected for a quarterly budget.
    if (midQuarterMonth) {
      const bad = await api(owner, "POST", "/api/expense_budgets", {
        category_id: null,
        month: midQuarterMonth,
        amount: 100,
        period_type: "quarterly",
      });
      assert.equal(bad.status, 400);
    }

    // Spend 450 this month: 90% of the monthly budget, 15% of the quarter.
    const expense = await api(owner, "POST", "/api/expenses", {
      title: `Tools utilities ${stamp}`,
      amount: 450,
      category_id: null,
      payment_method: "Cash",
      expense_date: today,
    });
    assert.equal(expense.status, 201);

    const list = await api(owner, "GET", "/api/expense_budgets");
    const budgets = list.body.data as {
      periodType: string;
      amount: number;
      actualAmount: number;
      utilizationPercent: number | null;
      alertTriggered: boolean;
    }[];
    const monthlyRow = budgets.find((b) => b.periodType === "monthly")!;
    const quarterlyRow = budgets.find((b) => b.periodType === "quarterly")!;
    assert.equal(monthlyRow.actualAmount, 450);
    assert.equal(monthlyRow.utilizationPercent, 90);
    assert.equal(monthlyRow.alertTriggered, true);
    assert.equal(quarterlyRow.actualAmount, 450);
    assert.equal(quarterlyRow.utilizationPercent, 15);
    assert.equal(quarterlyRow.alertTriggered, false);

    // Duplicate scope+period is rejected; the other period type coexists.
    const dup = await api(owner, "POST", "/api/expense_budgets", {
      category_id: null,
      month: monthStart,
      amount: 1,
      period_type: "monthly",
    });
    assert.equal(dup.status, 409);
  });

  it("raises threshold alert notifications via the sweep", async () => {
    const { runBudgetAlertSweeps } = await import(
      "../modules/expenses/expenses.budgets.alerts.js"
    );
    const alertsForBusiness = async (): Promise<number> => {
      const { db } = await import("../db/schema/index.js");
      const { notifications } = await import("../db/schema/notifications.js");
      const [row] = await db
        .select({ value: sql<string>`count(*)` })
        .from(notifications)
        .where(
          and(
            eq(notifications.businessId, owner.businessId),
            eq(notifications.kind, "budget_alert"),
          ),
        );
      return Number(row?.value ?? 0);
    };

    await runBudgetAlertSweeps();
    // The 90% monthly budget raises exactly one deduplicated alert for this
    // business. (The global counter spans all businesses — parallel test
    // processes mutate it, so assertions are scoped to this business.)
    assert.equal(await alertsForBusiness(), 1);
    // Re-running the same day is deduplicated — still exactly one.
    await runBudgetAlertSweeps();
    assert.equal(await alertsForBusiness(), 1);
  });

  it("records a loan (DR cash / CR 2080) and split repayments (2080 + 5090)", async () => {
    const before = await balances();
    const loan = await api(owner, "POST", "/api/finance/loans", {
      lenderType: "bank",
      lenderName: "City Bank SME",
      principal: 50000,
      interestRate: 12,
      loanDate: today,
      method: "cash",
      installmentCount: 10,
    });
    assert.equal(loan.status, 201, JSON.stringify(loan.body));
    const loanId = loan.body.id;

    const afterLoan = await balances();
    assert.equal((afterLoan.get("1010") ?? 0) - (before.get("1010") ?? 0), 50000);
    assert.equal((afterLoan.get("2080") ?? 0) - (before.get("2080") ?? 0), -50000);

    // Repayment: principal 10000 + interest 500 (never conflated).
    const repayment = await api(owner, "POST", `/api/finance/loans/${loanId}/repayments`, {
      principalAmount: 10000,
      interestAmount: 500,
      method: "cash",
    });
    assert.equal(repayment.status, 201, JSON.stringify(repayment.body));
    const afterRepay = await balances();
    assert.equal((afterRepay.get("2080") ?? 0) - (afterLoan.get("2080") ?? 0), 10000);
    assert.equal((afterRepay.get("5090") ?? 0) - (afterLoan.get("5090") ?? 0), 500);
    assert.equal((afterRepay.get("1010") ?? 0) - (afterLoan.get("1010") ?? 0), -10500);

    const list = await api(owner, "GET", "/api/finance/loans");
    const row = list.body.rows.find((l: { id: number }) => l.id === loanId);
    assert.equal(row.outstanding, "40000.00");

    // Over-repayment of the principal is rejected.
    const tooMuch = await api(owner, "POST", `/api/finance/loans/${loanId}/repayments`, {
      principalAmount: 60000,
    });
    assert.equal(tooMuch.status, 400);

    // Final repayment auto-closes the loan.
    const final = await api(owner, "POST", `/api/finance/loans/${loanId}/repayments`, {
      principalAmount: 40000,
      method: "cash",
    });
    assert.equal(final.status, 201);
    const closed = await api(owner, "GET", "/api/finance/loans");
    const closedRow = closed.body.rows.find((l: { id: number }) => l.id === loanId);
    assert.equal(closedRow.status, "closed");

    const afterClose = await api(owner, "POST", `/api/finance/loans/${loanId}/repayments`, {
      principalAmount: 1,
    });
    assert.equal(afterClose.status, 409);
    await assertBooksBalanced();
  });

  it("depreciates assets straight-line, idempotently per month", async () => {
    const before = await balances();
    const asset = await api(owner, "POST", "/api/finance/assets", {
      name: "Espresso Machine",
      category: "equipment",
      acquiredAt: today,
      cost: 12000,
      usefulLifeMonths: 60,
      method: "cash",
    });
    assert.equal(asset.status, 201, JSON.stringify(asset.body));

    const afterAcquire = await balances();
    assert.equal((afterAcquire.get("1080") ?? 0) - (before.get("1080") ?? 0), 12000);
    assert.equal((afterAcquire.get("1010") ?? 0) - (before.get("1010") ?? 0), -12000);

    // Depreciate the CURRENT month: 12000 / 60 = 200.
    const run = await api(owner, "POST", "/api/finance/assets/depreciation/run", {
      periodMonth: monthStart,
    });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.posted, 1);
    assert.equal(run.body.totalAmount, "200.00");

    const afterDep = await balances();
    assert.equal((afterDep.get("5100") ?? 0) - (afterAcquire.get("5100") ?? 0), 200);
    // Contra-asset (credit-normal): goes negative.
    assert.equal((afterDep.get("1090") ?? 0) - (afterAcquire.get("1090") ?? 0), -200);

    // Idempotent: a second run for the same month posts nothing.
    const rerun = await api(owner, "POST", "/api/finance/assets/depreciation/run", {
      periodMonth: monthStart,
    });
    assert.equal(rerun.body.posted, 0);

    const list = await api(owner, "GET", "/api/finance/assets");
    const row = list.body.rows[0];
    assert.equal(row.accumulatedDepreciation, "200.00");
    assert.equal(row.bookValue, "11800.00");
    await assertBooksBalanced();
  });

  it("builds a balanced balance sheet with net worth", async () => {
    const res = await api(owner, "GET", "/api/finance/balance-sheet");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.balanced, true, "A must equal L + E");

    const totalAssets = Number(res.body.assets.total);
    const totalLiabilities = Number(res.body.liabilities.total);
    const totalEquity = Number(res.body.equity.total);
    assert.equal(totalAssets - totalLiabilities, Number(res.body.netWorth));
    assert.equal(totalAssets, totalLiabilities + totalEquity);

    // Spot-check with the seeded figures:
    // cash 37050 (50000 + 50000 − 10500 − 40000 − 12000 − 450)
    // + net fixed 11800 = 48850; the loan fully repaid → liabilities 0;
    // equity 50000 − 1150 (interest 500 + depreciation 200 + utilities 450).
    assert.equal(totalAssets, 48850);
    assert.equal(totalLiabilities, 0);
    assert.equal(res.body.equity.currentEarnings, "-1150.00");
    assert.equal(res.body.netWorth, "48850.00");
  });

  it("enforces permissions on the new endpoints", async () => {
    const accountantLoans = await api(accountant, "GET", "/api/finance/loans");
    assert.equal(accountantLoans.status, 200);
    const accountantLoanCreate = await api(accountant, "POST", "/api/finance/loans", {
      lenderType: "bank",
      lenderName: "Nope",
      principal: 1,
    });
    assert.equal(accountantLoanCreate.status, 403);

    const accountantAssets = await api(accountant, "GET", "/api/finance/assets");
    assert.equal(accountantAssets.status, 200);
    const accountantAssetCreate = await api(accountant, "POST", "/api/finance/assets", {
      name: "Nope",
      category: "equipment",
      acquiredAt: today,
      cost: 1,
      usefulLifeMonths: 12,
    });
    assert.equal(accountantAssetCreate.status, 403);

    const cashierLoans = await api(cashier, "GET", "/api/finance/loans");
    assert.equal(cashierLoans.status, 403);
    const cashierAssets = await api(cashier, "GET", "/api/finance/assets");
    assert.equal(cashierAssets.status, 403);
    const cashierBalanceSheet = await api(cashier, "GET", "/api/finance/balance-sheet");
    assert.equal(cashierBalanceSheet.status, 403);
  });

  async function assertBooksBalanced(): Promise<void> {
    const tb = await api(owner, "GET", "/api/finance/trial-balance");
    assert.equal(tb.body.balanced, true, JSON.stringify(tb.body));
  }
});
