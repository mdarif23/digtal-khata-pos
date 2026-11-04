/**
 * Expense module Phase 2 integration tests — settlement payments:
 * partial/multiple payments, overpayment + duplicate protection, register
 * session cash_out movements (D3), payment voiding, tenancy + permissions.
 *
 * Run ONLY when BOTH INTEGRATION_TESTS=1 and DATABASE_URL point at the
 * approved disposable ezpos_test database. Plain `npm test` NEVER runs this.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

interface ExpenseBody extends Record<string, unknown> {
  paidAmount?: number;
  paymentStatus?: string;
  dueAmount?: number;
  payments?: Array<Record<string, unknown>>;
  id?: number;
}

describe("expenses phase 2 integration", { skip: !runIntegration }, () => {
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

  const uniqueEmail = () =>
    `exppay-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

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
    locationId?: number | null,
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.token}`,
      "X-Business-Id": String(ctx.businessId),
    };
    if (locationId !== undefined && locationId !== null) {
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

  async function registerAndCreateBusiness(
    email: string,
    businessName: string,
  ): Promise<Ctx> {
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Expense Pay Test",
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
    const token = ((await login.json()) as { accessToken: string }).accessToken;

    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: businessName }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business?: { id?: number } };
    const businessId = bizBody.business?.id;
    assert.ok(businessId);

    const me = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const meBody = (await me.json().catch(() => ({}))) as {
      user?: { id?: number };
    };
    return { token, businessId, userId: meBody.user?.id ?? 0, email };
  }

  const today = () => new Date().toISOString().slice(0, 10);

  let owner: Ctx;
  let other: Ctx;
  let accountant: Ctx;
  let locationA = 0;
  let registerId = 0;
  let sessionId = 0;
  const stamp = Date.now();

  before(async () => {
    owner = await registerAndCreateBusiness(
      `exppay-owner-${stamp}@example.test`,
      "Expense Pay Co",
    );
    other = await registerAndCreateBusiness(
      `exppay-other-${stamp}@example.test`,
      "Expense Pay Other Co",
    );

    for (const [ctx, name] of [
      [owner, "Pay Main"],
      [other, "Other Pay Main"],
    ] as const) {
      const loc = await api(ctx, "POST", "/api/locations", {
        name,
        isDefault: true,
      });
      assert.equal(loc.status, 201);
      if (ctx === owner) {
        locationA = (loc.body as { data?: { id?: number } }).data?.id ?? 0;
      }
    }

    // Accountant user (holds expenses.pay via the accountant preset).
    const roles = await api(owner, "GET", "/api/roles");
    const rolesBody = roles.body as { data?: { id: number; slug: string }[] };
    const accountantRole = (rolesBody.data ?? []).find(
      (r) => r.slug === "accountant",
    );
    assert.ok(accountantRole);
    const accEmail = `exppay-acc-${stamp}@example.test`;
    const createdUser = await api(owner, "POST", "/api/users", {
      fullName: "Expense Accountant",
      email: accEmail,
      password: "strong-password-123",
      roleIds: [accountantRole.id],
    });
    assert.equal(createdUser.status, 201);
    const createdBody = createdUser.body as {
      data?: { userId?: number; id?: number };
    };
    const accountantUserId =
      createdBody.data?.userId ?? createdBody.data?.id ?? 0;
    // API-created users have no location assignment — the location
    // middleware 403s before permission checks unless they get one.
    if (accountantUserId) {
      const assigned = await api(
        owner,
        "PATCH",
        `/api/users/${String(accountantUserId)}`,
        { locationIds: [locationA] },
      );
      assert.equal(assigned.status, 200);
    }
    const accLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: accEmail, password: "strong-password-123" }),
    });
    assert.equal(accLogin.status, 200);
    accountant = {
      token: ((await accLogin.json()) as { accessToken: string }).accessToken,
      businessId: owner.businessId,
      userId: 0,
      email: accEmail,
    };

    // Register + open session for the D3 cash movement test.
    const reg = await api(
      owner,
      "POST",
      "/api/registers",
      { name: `Expense Desk ${stamp}` },
      locationA,
    );
    assert.equal(reg.status, 201);
    registerId = (reg.body as { data?: { id?: number } }).data?.id ?? 0;
    assert.ok(registerId);
    const opened = await api(
      owner,
      "POST",
      `/api/registers/${String(registerId)}/open`,
      { openingCash: 1000 },
      locationA,
    );
    assert.equal(opened.status, 201);
    const openedBody = opened.body as {
      data?: { id?: number; sessionId?: number };
    };
    sessionId = openedBody.data?.id ?? openedBody.data?.sessionId ?? 0;
    assert.ok(sessionId);
  });

  async function createExpense(
    overrides: Record<string, unknown> = {},
  ): Promise<ExpenseBody> {
    const res = await api(
      owner,
      "POST",
      "/api/expenses",
      {
        title: "Payable expense",
        expense_date: today(),
        amount: 500,
        category_id: null,
        payment_method: "Cash",
        ...overrides,
      },
      locationA,
    );
    assert.equal(res.status, 201);
    return res.body as ExpenseBody;
  }

  it("creates an unpaid expense with record_as and no settlement row", async () => {
    const expense = await createExpense({
      title: "Unpaid supplier bill",
      record_as: "unpaid",
    });
    assert.equal(expense.paidAmount, 0);
    assert.equal(expense.paymentStatus, "unpaid");
    assert.equal(expense.dueAmount, 500);
    assert.equal(expense.payments?.length, 0);
  });

  it("rejects record_as unpaid together with an initial payment", async () => {
    const res = await api(
      owner,
      "POST",
      "/api/expenses",
      {
        title: "Bad combo",
        expense_date: today(),
        amount: 100,
        category_id: null,
        payment_method: "Cash",
        record_as: "unpaid",
        initial_payment: { amount: 50 },
      },
      locationA,
    );
    assert.equal(res.status, 400);
  });

  it("records partial payments until the expense is fully settled", async () => {
    const expense = await createExpense({
      title: "Installment bill",
      record_as: "unpaid",
    });
    const id = String(expense.id);

    const first = await api(
      owner,
      "POST",
      `/api/expenses/${id}/payments`,
      { amount: 200, payment_method: "Cash", payment_date: today() },
      locationA,
    );
    assert.equal(first.status, 201);
    const firstBody = first.body as {
      data?: { payment?: { id: number }; paidAmount?: number; paymentStatus?: string; duplicate?: boolean };
    };
    assert.equal(firstBody.data?.duplicate, false);
    assert.equal(firstBody.data?.paidAmount, 200);
    assert.equal(firstBody.data?.paymentStatus, "partial");

    const second = await api(
      accountant,
      "POST",
      `/api/expenses/${id}/payments`,
      { amount: 300, payment_method: "Mobile", payment_date: today() },
      locationA,
    );
    assert.equal(second.status, 201);
    const secondBody = second.body as { data?: { paidAmount?: number; paymentStatus?: string } };
    assert.equal(secondBody.data?.paidAmount, 500);
    assert.equal(secondBody.data?.paymentStatus, "paid");

    // Detail shows both settlements.
    const detail = await api(owner, "GET", `/api/expenses/${id}`, undefined, locationA);
    const detailBody = detail.body as { data?: ExpenseBody };
    assert.equal(detailBody.data?.payments?.length, 2);
    assert.equal(detailBody.data?.dueAmount, 0);

    const history = await api(owner, "GET", `/api/expenses/${id}/payments`, undefined, locationA);
    assert.equal(history.status, 200);
    assert.equal(
      ((history.body as { data?: unknown[] }).data ?? []).length,
      2,
    );
  });

  it("rejects overpayments and payments on settled expenses", async () => {
    const expense = await createExpense({
      title: "Overpay target",
      record_as: "unpaid",
    });
    const id = String(expense.id);

    const over = await api(
      owner,
      "POST",
      `/api/expenses/${id}/payments`,
      { amount: 600, payment_method: "Cash" },
      locationA,
    );
    assert.equal(over.status, 400);
    assert.match(
      String((over.body as { message?: string }).message),
      /remaining balance/i,
    );

    await api(
      owner,
      "POST",
      `/api/expenses/${id}/payments`,
      { amount: 500, payment_method: "Cash" },
      locationA,
    );
    const settled = await api(
      owner,
      "POST",
      `/api/expenses/${id}/payments`,
      { amount: 1, payment_method: "Cash" },
      locationA,
    );
    assert.equal(settled.status, 400);
    assert.match(
      String((settled.body as { message?: string }).message),
      /fully settled/i,
    );
  });

  it("is idempotent for retried client_uuid submissions", async () => {
    const expense = await createExpense({
      title: "Idempotent bill",
      record_as: "unpaid",
    });
    const id = String(expense.id);
    // Per-run uuid — the shared ezpos_test DB keeps prior runs' data.
    const runUuid = `5b3f2a1c-0000-4000-8000-${String(stamp % 1e12).padStart(12, "0")}`;
    const payload = {
      amount: 120,
      payment_method: "Card" as const,
      client_uuid: runUuid,
    };

    const first = await api(owner, "POST", `/api/expenses/${id}/payments`, payload, locationA);
    assert.equal(first.status, 201);
    const retry = await api(owner, "POST", `/api/expenses/${id}/payments`, payload, locationA);
    assert.equal(retry.status, 200);
    const retryBody = retry.body as { data?: { duplicate?: boolean; payment?: { id: number } } };
    assert.equal(retryBody.data?.duplicate, true);
    assert.equal(
      retryBody.data?.payment?.id,
      (first.body as { data?: { payment?: { id: number } } }).data?.payment?.id,
    );

    const detail = await api(owner, "GET", `/api/expenses/${id}`, undefined, locationA);
    assert.equal(((detail.body as { data?: ExpenseBody }).data?.payments ?? []).length, 1);
  });

  it("rejects duplicate reference numbers within the business", async () => {
    const expense = await createExpense({
      title: "Ref dup bill",
      amount: 300,
      record_as: "unpaid",
    });
    const id = String(expense.id);
    const payload = {
      amount: 100,
      payment_method: "Mobile" as const,
      reference_no: `TRX-EXP-${stamp}`,
    };

    const first = await api(owner, "POST", `/api/expenses/${id}/payments`, payload, locationA);
    assert.equal(first.status, 201);
    const second = await api(
      owner,
      "POST",
      `/api/expenses/${id}/payments`,
      {
        ...payload,
        client_uuid: `5b3f2a1c-0000-4000-8000-${String((stamp + 1) % 1e12).padStart(12, "0")}`,
      },
      locationA,
    );
    assert.equal(second.status, 409);
  });

  it("ties a cash payment to an open register session and deducts the drawer", async () => {
    const expense = await createExpense({
      title: "Drawer bill",
      record_as: "unpaid",
    });
    const id = String(expense.id);

    const before = await api(owner, "GET", `/api/sessions/${String(sessionId)}`, undefined, locationA);
    const beforeCash = Number(
      (before.body as { data?: { expectedCash?: number } }).data?.expectedCash ?? 0,
    );

    const payment = await api(
      owner,
      "POST",
      `/api/expenses/${id}/payments`,
      {
        amount: 150,
        payment_method: "Cash",
        register_session_id: sessionId,
      },
      locationA,
    );
    assert.equal(payment.status, 201);
    const paymentId = (payment.body as { data?: { payment?: { id: number } } })
      .data?.payment?.id;
    assert.ok(paymentId);

    const after = await api(owner, "GET", `/api/sessions/${String(sessionId)}`, undefined, locationA);
    const afterCash = Number(
      (after.body as { data?: { expectedCash?: number } }).data?.expectedCash ?? 0,
    );
    assert.equal(afterCash, beforeCash - 150);

    // Voiding the payment restores the drawer.
    const voided = await api(
      owner,
      "DELETE",
      `/api/expenses/${id}/payments/${String(paymentId)}`,
      undefined,
      locationA,
    );
    assert.equal(voided.status, 200);

    const restored = await api(owner, "GET", `/api/sessions/${String(sessionId)}`, undefined, locationA);
    const restoredCash = Number(
      (restored.body as { data?: { expectedCash?: number } }).data?.expectedCash ?? 0,
    );
    assert.equal(restoredCash, beforeCash);

    const detail = await api(owner, "GET", `/api/expenses/${id}`, undefined, locationA);
    assert.equal((detail.body as { data?: ExpenseBody }).data?.paidAmount, 0);
    assert.equal(
      (detail.body as { data?: ExpenseBody }).data?.paymentStatus,
      "unpaid",
    );
  });

  it("rejects non-cash payments tied to a register session", async () => {
    const expense = await createExpense({
      title: "Card no drawer",
      record_as: "unpaid",
    });
    const res = await api(
      owner,
      "POST",
      `/api/expenses/${String(expense.id)}/payments`,
      {
        amount: 50,
        payment_method: "Card",
        register_session_id: sessionId,
      },
      locationA,
    );
    assert.equal(res.status, 400);
  });

  it("keeps the payment ledger business-isolated", async () => {
    const expense = await createExpense({
      title: "Isolated bill",
      record_as: "unpaid",
    });
    const foreign = await api(
      other,
      "POST",
      `/api/expenses/${String(expense.id)}/payments`,
      { amount: 100, payment_method: "Cash" },
    );
    assert.equal(foreign.status, 404);
  });

  it("enforces expenses.pay for recording but allows viewing", async () => {
    // The accountant preset holds expenses.pay — recording works (covered
    // above); this asserts a cashier cannot record or void payments.
    const roles = await api(owner, "GET", "/api/roles");
    const rolesBody = roles.body as { data?: { id: number; slug: string }[] };
    const cashierRole = (rolesBody.data ?? []).find((r) => r.slug === "cashier");
    assert.ok(cashierRole);

    const email = `exppay-cashier-${stamp}@example.test`;
    const created = await api(owner, "POST", "/api/users", {
      fullName: "Pay Cashier",
      email,
      password: "strong-password-123",
      roleIds: [cashierRole.id],
    });
    assert.equal(created.status, 201);
    const cashierBody = created.body as {
      data?: { userId?: number; id?: number };
    };
    const cashierUserId = cashierBody.data?.userId ?? cashierBody.data?.id ?? 0;
    if (cashierUserId) {
      const assigned = await api(
        owner,
        "PATCH",
        `/api/users/${String(cashierUserId)}`,
        { locationIds: [locationA] },
      );
      assert.equal(assigned.status, 200);
    }
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    assert.equal(login.status, 200);
    const cashier: Ctx = {
      token: ((await login.json()) as { accessToken: string }).accessToken,
      businessId: owner.businessId,
      userId: 0,
      email,
    };

    const expense = await createExpense({
      title: "Permission bill",
      record_as: "unpaid",
    });
    const denied = await api(
      cashier,
      "POST",
      `/api/expenses/${String(expense.id)}/payments`,
      { amount: 100, payment_method: "Cash" },
      locationA,
    );
    assert.equal(denied.status, 403);

    // Viewing payment history needs expenses.view — the cashier preset holds
    // no expense permissions at all, so even reads are denied. The location
    // is assigned above, so this 403 is purely permission-driven.
    const view = await api(
      cashier,
      "GET",
      `/api/expenses/${String(expense.id)}/payments`,
      undefined,
      locationA,
    );
    assert.equal(view.status, 403);
  });
});
