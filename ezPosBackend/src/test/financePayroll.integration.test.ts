/**
 * Staff & Payroll integration tests (Finance & Growth Stage 5).
 *
 * Covers: employee CRUD + duplicate-user guard, salary structure versioning,
 * advances as an ASSET (DR 1060 / CR cash, client_uuid idempotent), the
 * documented calculation formulas (monthly pay with attendance deductions
 * and overtime), the advance FIFO recovery, duplicate period/record guards,
 * approval accrual (DR 5020 / CR 2030 + CR 1060), partial salary payments
 * with the period status machine, payslip data, cancellation/reopen guards,
 * permission enforcement and the A = L + E invariant.
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

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

describe("payroll integration", { skip: !runIntegration }, () => {
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
      body: JSON.stringify({ name: `Payroll Biz ${name}` }),
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
    const email = `${slug}-pay-${stamp}-${Math.floor(Math.random() * 1e6)}@example.test`;
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

  async function assertBooksBalanced(): Promise<void> {
    const tb = await api(owner, "GET", "/api/finance/trial-balance");
    assert.equal(tb.body.balanced, true, JSON.stringify(tb.body));
  }

  let owner: Ctx;
  let accountant: Ctx;
  let cashier: Ctx;
  let employeeAId = 0;
  let employeeBId = 0;
  let periodId = 0;

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const nextMonthStart = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;
  const standardDays = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
  ).getDate();

  before(async () => {
    owner = await createOwner("payowner");
    accountant = await createStaff(owner, "accountant", "Pay Accountant");
    cashier = await createStaff(owner, "cashier", "Pay Cashier");
    const activation = await api(owner, "POST", "/api/finance/activation", {
      accounts: [{ name: "Cash Drawer", type: "cash", openingBalance: 20000 }],
      ownerCapital: 20000,
    });
    assert.equal(activation.status, 201, JSON.stringify(activation.body));
  });

  it("creates employees with generated codes and versioned structures", async () => {
    const a = await api(owner, "POST", "/api/payroll/employees", {
      fullName: "Rahim Uddin",
      designation: "Salesperson",
      department: "Sales",
      paymentMethod: "cash",
      salaryStructure: {
        payType: "monthly",
        basicAmount: 15000,
        allowances: [{ name: "Transport", amount: 1000 }],
      },
    });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.match(a.body.employeeCode, /^EMP-\d{4}-\d{6}$/);
    employeeAId = a.body.id;

    const b = await api(owner, "POST", "/api/payroll/employees", {
      fullName: "Karim Ali",
      department: "Sales",
      salaryStructure: { payType: "monthly", basicAmount: 10000 },
    });
    assert.equal(b.status, 201);
    employeeBId = b.body.id;

    // A first employee may link the platform user; a second one may not.
    const linked = await api(owner, "POST", "/api/payroll/employees", {
      fullName: "Linked Owner",
      userId: owner.userId,
    });
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    const dup = await api(owner, "POST", "/api/payroll/employees", {
      fullName: "Copy",
      userId: owner.userId,
    });
    assert.equal(dup.status, 409);

    // Structure versioning: a new structure retires the active one.
    const v2 = await api(owner, "POST", `/api/payroll/employees/${employeeBId}/salary-structures`, {
      payType: "monthly",
      basicAmount: 11000,
    });
    assert.equal(v2.status, 201);
    const detail = await api(owner, "GET", `/api/payroll/employees/${employeeBId}`);
    const active = detail.body.structures.filter(
      (s: { isActive: boolean }) => s.isActive,
    );
    assert.equal(active.length, 1);
    assert.equal(active[0].basicAmount, "11000.00");
  });

  it("records a salary advance as an asset (DR 1060 / CR cash)", async () => {
    const before = await balances();
    const res = await api(owner, "POST", `/api/payroll/employees/${employeeAId}/advances`, {
      amount: 3000,
      reason: "Family emergency",
      method: "cash",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const after = await balances();
    assert.equal((after.get("1060") ?? 0) - (before.get("1060") ?? 0), 3000);
    assert.equal((after.get("1010") ?? 0) - (before.get("1010") ?? 0), -3000);

    const detail = await api(owner, "GET", `/api/payroll/employees/${employeeAId}`);
    assert.equal(detail.body.advanceOutstanding, "3000.00");
    await assertBooksBalanced();
  });

  it("creates a draft period with the documented calculations", async () => {
    const res = await api(owner, "POST", "/api/payroll/periods", {
      periodStart: monthStart,
      employeeIds: [employeeAId, employeeBId],
      records: [
        {
          employeeId: employeeAId,
          overtimeHours: 10,
          bonusAmount: 1000,
          advanceDeduction: 2000,
        },
        {
          employeeId: employeeBId,
          absentDays: 2,
          otherDeductions: 100,
        },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    periodId = res.body.id;

    const recordA = res.body.records.find(
      (r: { employeeId: number }) => r.employeeId === employeeAId,
    );
    const recordB = res.body.records.find(
      (r: { employeeId: number }) => r.employeeId === employeeBId,
    );

    // A: full basic + 1000 allowance + OT(10h at basic/days/8) + 1000 bonus − 2000 advance.
    const otRate = round2(round2(15000 / standardDays / 8));
    const expectedGrossA = round2(15000 + 1000 + round2(otRate * 10) + 1000);
    assert.equal(recordA.basicAmount, "15000.00");
    assert.equal(recordA.allowancesTotal, "1000.00");
    assert.equal(recordA.overtimeAmount, round2(otRate * 10).toFixed(2));
    assert.equal(recordA.grossAmount, expectedGrossA.toFixed(2));
    assert.equal(recordA.advanceDeduction, "2000.00");
    assert.equal(recordA.netAmount, round2(expectedGrossA - 2000).toFixed(2));

    // B: attendance deduction (2 absent days) then − 100 other deductions.
    // B's active structure is the v2 raise from the versioning test (11000).
    const basicB = 11000;
    const attendanceDeduction = round2((basicB / standardDays) * 2);
    const expectedBasicB = round2(basicB - attendanceDeduction);
    assert.equal(recordB.basicAmount, expectedBasicB.toFixed(2));
    assert.equal(recordB.grossAmount, expectedBasicB.toFixed(2));
    assert.equal(recordB.netAmount, round2(expectedBasicB - 100).toFixed(2));

    // The advance deduction consumed part of the open advance (FIFO).
    const detail = await api(owner, "GET", `/api/payroll/employees/${employeeAId}`);
    assert.equal(detail.body.advanceOutstanding, "1000.00");

    // Duplicate month is rejected.
    const again = await api(owner, "POST", "/api/payroll/periods", {
      periodStart: monthStart,
      employeeIds: [employeeAId],
    });
    assert.equal(again.status, 409);
  });

  it("adjusts a draft record and re-applies the advance FIFO", async () => {
    const res = await api(
      owner,
      "PATCH",
      `/api/payroll/periods/${periodId}/records/${(
        (await api(owner, "GET", `/api/payroll/periods/${periodId}`)).body.records.find(
          (r: { employeeId: number }) => r.employeeId === employeeAId,
        ) as { id: number }
      ).id}`,
      { advanceDeduction: 1000 },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // Outstanding restored to 3000 then re-deducted to 2000.
    const detail = await api(owner, "GET", `/api/payroll/employees/${employeeAId}`);
    assert.equal(detail.body.advanceOutstanding, "2000.00");
  });

  it("approves the period and posts the accrual (5020/2030/1060)", async () => {
    const before = await balances();
    const periodBefore = await api(owner, "GET", `/api/payroll/periods/${periodId}`);
    const gross = periodBefore.body.grossTotal as string;
    const advanceRecovery = periodBefore.body.advanceRecoveryTotal as string;
    const payable = round2(Number(gross) - Number(advanceRecovery));

    const res = await api(owner, "POST", `/api/payroll/periods/${periodId}/approve`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "approved");

    const after = await balances();
    assert.equal((after.get("5020") ?? 0) - (before.get("5020") ?? 0), Number(gross));
    // Payable is credit-normal: goes negative by (gross − advance recovery).
    assert.equal((after.get("2030") ?? 0) - (before.get("2030") ?? 0), -payable);
    // Advance asset reduced by the recovery.
    assert.equal(
      (after.get("1060") ?? 0) - (before.get("1060") ?? 0),
      -Number(advanceRecovery),
    );

    // Duplicate approval is rejected.
    const again = await api(owner, "POST", `/api/payroll/periods/${periodId}/approve`);
    assert.equal(again.status, 409);
    await assertBooksBalanced();
  });

  it("pays a salary partially, rejects overpayment, then settles fully", async () => {
    const period = await api(owner, "GET", `/api/payroll/periods/${periodId}`);
    const recordA = period.body.records.find(
      (r: { employeeId: number }) => r.employeeId === employeeAId,
    );
    const net = Number(recordA.netAmount as string);

    const before = await balances();
    const half = await api(
      owner,
      "POST",
      `/api/payroll/records/${recordA.id}/payments`,
      { amount: round2(net / 2), method: "cash" },
    );
    assert.equal(half.status, 201, JSON.stringify(half.body));

    const afterHalf = await balances();
    assert.equal(
      (afterHalf.get("2030") ?? 0) - (before.get("2030") ?? 0),
      round2(net / 2),
    );

    // Overpayment rejected.
    const tooMuch = await api(
      owner,
      "POST",
      `/api/payroll/records/${recordA.id}/payments`,
      { amount: net },
    );
    assert.equal(tooMuch.status, 400);

    // Settle the rest.
    const rest = await api(
      owner,
      "POST",
      `/api/payroll/records/${recordA.id}/payments`,
      { amount: round2(net - round2(net / 2)), method: "cash" },
    );
    assert.equal(rest.status, 201);

    const payslip = await api(owner, "GET", `/api/payroll/records/${recordA.id}/payslip`);
    assert.equal(payslip.status, 200);
    assert.equal(payslip.body.paymentStatus, "paid");
    assert.equal(payslip.body.netAmount, net.toFixed(2));
    assert.equal(payslip.body.paidAmount, net.toFixed(2));
    await assertBooksBalanced();
  });

  it("guards cancellation and supports cancel → reopen on a clean period", async () => {
    // The current period has payments — cannot cancel.
    const blocked = await api(owner, "POST", `/api/payroll/periods/${periodId}/cancel`, {
      reason: "Nope",
    });
    assert.equal(blocked.status, 409);

    // Next month: create → approve → cancel (reverses the accrual) → reopen.
    const created = await api(owner, "POST", "/api/payroll/periods", {
      periodStart: nextMonthStart,
      employeeIds: [employeeBId],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const beforeApproval = await balances();
    const approved = await api(
      owner,
      "POST",
      `/api/payroll/periods/${created.body.id}/approve`,
    );
    assert.equal(approved.status, 200);

    const before = await balances();
    const cancelled = await api(
      owner,
      "POST",
      `/api/payroll/periods/${created.body.id}/cancel`,
      { reason: "Wrong month" },
    );
    assert.equal(cancelled.status, 200);

    // The accrual reversal returns salary expense and payable to their
    // pre-approval values.
    const after = await balances();
    assert.equal(
      after.get("5020") ?? 0,
      beforeApproval.get("5020") ?? 0,
    );
    assert.equal(
      after.get("2030") ?? 0,
      beforeApproval.get("2030") ?? 0,
    );

    const reopened = await api(
      owner,
      "POST",
      `/api/payroll/periods/${created.body.id}/reopen`,
    );
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.status, "draft");
    await assertBooksBalanced();
  });

  it("enforces permissions: accountant cannot process/approve, cashier is blind", async () => {
    const accountantRun = await api(accountant, "POST", "/api/payroll/periods", {
      periodStart: "2030-04-01",
      employeeIds: [employeeBId],
    });
    assert.equal(accountantRun.status, 403);

    const accountantApprove = await api(
      accountant,
      "POST",
      `/api/payroll/periods/${periodId}/approve`,
    );
    assert.equal(accountantApprove.status, 403);

    const cashierList = await api(cashier, "GET", "/api/payroll/employees");
    assert.equal(cashierList.status, 403);
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
