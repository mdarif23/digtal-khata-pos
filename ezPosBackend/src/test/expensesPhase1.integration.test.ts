/**
 * Expense module Phase 1 integration tests (payments foundation + management
 * API): paginated/filtered list, detail, soft void, auto settlement payment,
 * export, category lifecycle basics, tenancy and location scoping.
 *
 * They exercise real endpoints against a REAL PostgreSQL database and INSERT
 * records. Double-guarded: run ONLY when BOTH —
 *   1. INTEGRATION_TESTS=1 is set explicitly, and
 *   2. DATABASE_URL points at the approved disposable ezpos_test database.
 *
 * FAIL-CLOSED: before the first write, the suite asserts that
 * current_database() is exactly 'ezpos_test' and aborts otherwise.
 *
 * Run with:
 *   DATABASE_URL=postgresql://.../ezpos_test INTEGRATION_TESTS=1 npm test
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

interface ExpenseListBody {
  success?: boolean;
  data?: Array<Record<string, unknown>>;
  meta?: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    summary: {
      totalAmount: number;
      totalPaid: number;
      totalDue: number;
      unpaidCount: number;
      partialCount: number;
      paidCount: number;
    };
  };
  message?: string;
}

describe("expenses phase 1 integration", { skip: !runIntegration }, () => {
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
    `exp-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

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
        fullName: "Expense Test",
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
    const loginBody = (await login.json()) as { accessToken: string };
    const token = loginBody.accessToken;

    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: businessName }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as {
      data?: { businessId?: number; id?: number };
      business?: { id?: number };
      businessId?: number;
      id?: number;
    };
    const businessId =
      bizBody.data?.businessId ??
      bizBody.data?.id ??
      bizBody.business?.id ??
      bizBody.businessId ??
      bizBody.id;
    assert.ok(businessId, `business creation returned no id: ${JSON.stringify(bizBody)}`);

    const me = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const meBody = (await me.json().catch(() => ({}))) as {
      user?: { id?: number };
      data?: { user?: { id?: number } };
    };
    const userId = meBody.user?.id ?? meBody.data?.user?.id ?? 0;

    return { token, businessId, userId, email };
  }

  const today = () => new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };

  const expensePayload = (overrides: Record<string, unknown> = {}) => ({
    title: "Test expense",
    expense_date: today(),
    amount: 100,
    category_id: null,
    payment_method: "Cash",
    ...overrides,
  });

  let owner: Ctx;
  let other: Ctx;
  let locationA = 0;
  let locationB = 0;
  let categoryId = 0;
  const stamp = Date.now();

  before(async () => {
    owner = await registerAndCreateBusiness(
      `exp-owner-${stamp}@example.test`,
      "Expense Test Co",
    );
    other = await registerAndCreateBusiness(
      `exp-other-${stamp}@example.test`,
      "Expense Other Co",
    );

    const locA = await api(owner, "POST", "/api/locations", {
      name: "Expense Main",
      isDefault: true,
    });
    assert.equal(locA.status, 201);
    const locARow = locA.body as { data?: { id?: number }; id?: number };
    locationA = locARow.data?.id ?? locARow.id ?? 0;

    const locB = await api(owner, "POST", "/api/locations", {
      name: "Expense Branch",
    });
    assert.equal(locB.status, 201);
    const locBRow = locB.body as { data?: { id?: number }; id?: number };
    locationB = locBRow.data?.id ?? locBRow.id ?? 0;

    const cat = await api(owner, "POST", "/api/expense_categories", {
      categoryName: `Rent ${stamp}`,
    });
    assert.equal(cat.status, 201);
    categoryId = (cat.body as { id?: number }).id ?? 0;

    // The isolation tests call the API as `other` — it needs a default
    // location or the location middleware 400s before the handler runs.
    const otherLoc = await api(other, "POST", "/api/locations", {
      name: "Other Main",
      isDefault: true,
    });
    assert.equal(otherLoc.status, 201);
  });

  it("creates an expense with a full auto settlement payment", async () => {
    const res = await api(
      owner,
      "POST",
      "/api/expenses",
      expensePayload({
        title: "Electricity bill",
        amount: 500,
        category_id: categoryId,
        payee: "DPDC",
        reference_no: "REF-001",
      }),
      locationA,
    );
    assert.equal(res.status, 201);
    const body = res.body as Record<string, unknown>;
    assert.equal(body.paidAmount, 500);
    assert.equal(body.paymentStatus, "paid");
    assert.equal(body.payee, "DPDC");
    assert.equal(body.dueAmount, 0);
    assert.equal(body.locationName, "Expense Main");
    assert.equal(body.categoryName, `Rent ${stamp}`);
    const payments = body.payments as Array<Record<string, unknown>>;
    assert.equal(payments.length, 1);
    assert.equal(payments[0]?.amount, 500);
    assert.equal(payments[0]?.paymentMethod, "Cash");
    assert.equal(payments[0]?.recordedBy, owner.userId);

    const detail = await api(
      owner,
      "GET",
      `/api/expenses/${String(body.id)}`,
      undefined,
      locationA,
    );
    assert.equal(detail.status, 200);
    const detailBody = detail.body as { success?: boolean; data?: Record<string, unknown> };
    assert.equal(detailBody.success, true);
    assert.equal((detailBody.data?.payments as unknown[]).length, 1);
  });

  it("creates a partially settled expense via initial_payment", async () => {
    const res = await api(
      owner,
      "POST",
      "/api/expenses",
      expensePayload({
        title: "Partial supply bill",
        amount: 400,
        initial_payment: { amount: 150 },
      }),
      locationA,
    );
    assert.equal(res.status, 201);
    const body = res.body as Record<string, unknown>;
    assert.equal(body.paidAmount, 150);
    assert.equal(body.paymentStatus, "partial");
    assert.equal(body.dueAmount, 250);
  });

  it("rejects an initial payment above the expense amount", async () => {
    const res = await api(
      owner,
      "POST",
      "/api/expenses",
      expensePayload({ amount: 100, initial_payment: { amount: 200 } }),
      locationA,
    );
    assert.equal(res.status, 400);
    assert.match(
      String((res.body as { message?: string }).message),
      /cannot exceed/i,
    );
  });

  it("returns the standard error envelope on invalid payloads", async () => {
    const res = await api(
      owner,
      "POST",
      "/api/expenses",
      { title: "", amount: -5 },
      locationA,
    );
    assert.equal(res.status, 400);
    const body = res.body as { success?: boolean; errors?: unknown };
    assert.equal(body.success, false);
    assert.ok(body.errors);
  });

  it("blocks reducing an amount below what is already paid and recomputes status", async () => {
    const created = await api(
      owner,
      "POST",
      "/api/expenses",
      expensePayload({ title: "Amount edit", amount: 300 }),
      locationA,
    );
    const id = String((created.body as Record<string, unknown>).id);

    const reduced = await api(
      owner,
      "PATCH",
      `/api/expenses/${id}`,
      expensePayload({ title: "Amount edit", amount: 50 }),
      locationA,
    );
    assert.equal(reduced.status, 400);
    assert.match(
      String((reduced.body as { message?: string }).message),
      /already paid/i,
    );

    const raised = await api(
      owner,
      "PATCH",
      `/api/expenses/${id}`,
      expensePayload({ title: "Amount edit", amount: 450 }),
      locationA,
    );
    assert.equal(raised.status, 200);
    const raisedBody = raised.body as Record<string, unknown>;
    // 300 paid against a 450 total = partial.
    assert.equal(raisedBody.paymentStatus, "partial");
    assert.equal(raisedBody.dueAmount, 150);
  });

  it("paginates, filters, sorts and summarises the list", async () => {
    // 8 more small expenses (11 total for this business now).
    for (let i = 1; i <= 8; i++) {
      const res = await api(
        owner,
        "POST",
        "/api/expenses",
        expensePayload({
          title: `Bulk expense ${String(i).padStart(2, "0")}`,
          amount: 10 * i,
          expense_date: daysAgo(i),
          category_id: i % 2 === 0 ? categoryId : null,
          payment_method: i % 3 === 0 ? "Card" : "Cash",
        }),
        locationA,
      );
      assert.equal(res.status, 201);
    }

    const page1 = await api(
      owner,
      "GET",
      "/api/expenses?page=1&page_size=5&sort=expense_date&sort_dir=desc",
      undefined,
      locationA,
    );
    assert.equal(page1.status, 200);
    const p1 = page1.body as ExpenseListBody;
    assert.equal(p1.success, true);
    assert.equal(p1.meta?.pageSize, 5);
    assert.equal(p1.meta?.totalPages, 3);
    assert.equal(p1.data?.length, 5);
    // 500 + 400 + 450 (edited) + 8 bulk rows (360) = 1710 total; settled:
    // 500 + 150 + 300 + 360 = 1310, so 400 outstanding across 2 partials.
    assert.equal(p1.meta?.summary.totalAmount, 1710);
    assert.equal(p1.meta?.summary.totalPaid, 1310);
    assert.equal(p1.meta?.summary.totalDue, 400);
    assert.equal(p1.meta?.summary.partialCount, 2);
    assert.equal(p1.meta?.summary.paidCount, 9);

    const page2 = await api(
      owner,
      "GET",
      "/api/expenses?page=2&page_size=5",
      undefined,
      locationA,
    );
    const p2 = page2.body as ExpenseListBody;
    assert.equal(p2.data?.length, 5);
    const ids1 = new Set(p1.data?.map((r) => r.id));
    for (const row of p2.data ?? []) {
      assert.ok(!ids1.has(row.id), "page 2 must not repeat page 1 rows");
    }

    const search = await api(
      owner,
      "GET",
      "/api/expenses?search=Bulk%20expense%2003",
      undefined,
      locationA,
    );
    const s = search.body as ExpenseListBody;
    assert.equal(s.data?.length, 1);
    assert.equal((s.data?.[0] ?? {}).title, "Bulk expense 03");

    const byCategory = await api(
      owner,
      "GET",
      `/api/expenses?category_id=${categoryId}&page_size=100`,
      undefined,
      locationA,
    );
    const bc = byCategory.body as ExpenseListBody;
    assert.equal(bc.data?.length, 5); // bulk 02/04/06/08 + electricity bill

    const uncategorized = await api(
      owner,
      "GET",
      "/api/expenses?category_id=none&page_size=100",
      undefined,
      locationA,
    );
    const uc = uncategorized.body as ExpenseListBody;
    assert.equal(uc.data?.length, 6);

    const partialOnly = await api(
      owner,
      "GET",
      "/api/expenses?payment_status=partial&page_size=100",
      undefined,
      locationA,
    );
    const po = partialOnly.body as ExpenseListBody;
    assert.equal(po.data?.length, 2);

    const cardOnly = await api(
      owner,
      "GET",
      "/api/expenses?payment_method=Card&page_size=100",
      undefined,
      locationA,
    );
    const co = cardOnly.body as ExpenseListBody;
    assert.equal(co.data?.length, 2); // bulk 03 & 06 (i % 3 === 0, i in 1..8)

    const dated = await api(
      owner,
      "GET",
      `/api/expenses?date_from=${daysAgo(4)}&date_to=${daysAgo(2)}&page_size=100`,
      undefined,
      locationA,
    );
    const dd = dated.body as ExpenseListBody;
    assert.equal(dd.data?.length, 3); // bulk 02/03/04

    const amountAsc = await api(
      owner,
      "GET",
      "/api/expenses?sort=amount&sort_dir=asc&page_size=3",
      undefined,
      locationA,
    );
    const aa = amountAsc.body as ExpenseListBody;
    const amounts = (aa.data ?? []).map((r) => Number(r.amount));
    assert.deepEqual(amounts, [10, 20, 30]);
  });

  it("scopes the list by an accessible location and rejects inaccessible ones", async () => {
    const otherLoc = await api(
      owner,
      "POST",
      "/api/expenses",
      expensePayload({ title: "Branch expense", amount: 70 }),
      locationB,
    );
    assert.equal(otherLoc.status, 201);

    const onlyA = await api(
      owner,
      "GET",
      `/api/expenses?locationId=${locationA}&page_size=100`,
      undefined,
      locationA,
    );
    const la = onlyA.body as ExpenseListBody;
    for (const row of la.data ?? []) {
      assert.equal(row.locationId, locationA);
    }
    assert.ok(!(la.data ?? []).some((r) => r.title === "Branch expense"));

    const foreign = await api(
      owner,
      "GET",
      `/api/expenses?locationId=999999&page_size=10`,
      undefined,
      locationA,
    );
    assert.equal(foreign.status, 403);
  });

  it("exports the filtered dataset with the same shape as the list", async () => {
    const res = await api(
      owner,
      "GET",
      "/api/expenses/export?search=Branch",
      undefined,
      locationA,
    );
    assert.equal(res.status, 200);
    const body = res.body as { success?: boolean; data?: Array<Record<string, unknown>> };
    assert.equal(body.success, true);
    assert.equal(body.data?.length, 1);
    assert.equal((body.data?.[0] ?? {}).title, "Branch expense");
  });

  it("soft-voids an expense and hides it from list, detail and the financial report", async () => {
    const created = await api(
      owner,
      "POST",
      "/api/expenses",
      expensePayload({ title: "To be voided", amount: 123 }),
      locationA,
    );
    const id = String((created.body as Record<string, unknown>).id);

    const before = await api(
      owner,
      "GET",
      "/api/reports/financial/expenses?from=2000-01-01&to=2999-01-01",
      undefined,
      locationA,
    );
    const beforeTotal = (before.body as { data?: { total?: number } }).data?.total ?? 0;

    const del = await api(
      owner,
      "DELETE",
      `/api/expenses/${id}`,
      { reason: "Duplicate entry" },
      locationA,
    );
    assert.equal(del.status, 200);

    const list = await api(
      owner,
      "GET",
      "/api/expenses?search=To%20be%20voided",
      undefined,
      locationA,
    );
    assert.equal(((list.body as ExpenseListBody).data ?? []).length, 0);

    const detail = await api(owner, "GET", `/api/expenses/${id}`, undefined, locationA);
    assert.equal(detail.status, 404);

    const reDelete = await api(owner, "DELETE", `/api/expenses/${id}`, undefined, locationA);
    assert.equal(reDelete.status, 404);

    const after = await api(
      owner,
      "GET",
      "/api/reports/financial/expenses?from=2000-01-01&to=2999-01-01",
      undefined,
      locationA,
    );
    const afterTotal = (after.body as { data?: { total?: number } }).data?.total ?? 0;
    assert.equal(afterTotal, beforeTotal - 1);
  });

  it("keeps expense records business-isolated", async () => {
    const created = await api(
      owner,
      "POST",
      "/api/expenses",
      expensePayload({ title: "Mine only", amount: 55 }),
      locationA,
    );
    const id = String((created.body as Record<string, unknown>).id);

    const foreignDetail = await api(other, "GET", `/api/expenses/${id}`);
    assert.equal(foreignDetail.status, 404);

    const foreignVoid = await api(other, "DELETE", `/api/expenses/${id}`);
    assert.equal(foreignVoid.status, 404);

    const foreignList = await api(other, "GET", "/api/expenses?page_size=100");
    const titles = ((foreignList.body as ExpenseListBody).data ?? []).map(
      (r) => r.title,
    );
    assert.ok(!titles.includes("Mine only"));
  });

  it("enforces expenses permissions per role", async () => {
    const roles = await api(owner, "GET", "/api/roles");
    const rolesBody = roles.body as { data?: { id: number; slug: string }[] };
    const cashierRole = (rolesBody.data ?? []).find((r) => r.slug === "cashier");
    assert.ok(cashierRole);

    const email = `exp-cashier-${stamp}@example.test`;
    const created = await api(owner, "POST", "/api/users", {
      fullName: "Expense Cashier",
      email,
      password: "strong-password-123",
      roleIds: [cashierRole.id],
    });
    assert.equal(created.status, 201);
    const createdBody = created.body as { data?: { userId?: number; id?: number } };
    const cashierUserId = createdBody.data?.userId ?? createdBody.data?.id ?? 0;

    const cashierLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    assert.equal(cashierLogin.status, 200);
    const cashierToken = ((await cashierLogin.json()) as { accessToken: string })
      .accessToken;
    const cashierCtx: Ctx = {
      token: cashierToken,
      businessId: owner.businessId,
      userId: cashierUserId,
      email,
    };

    const deniedList = await api(cashierCtx, "GET", "/api/expenses", undefined, locationA);
    assert.equal(deniedList.status, 403);

    const deniedCreate = await api(
      cashierCtx,
      "POST",
      "/api/expenses",
      expensePayload(),
      locationA,
    );
    assert.equal(deniedCreate.status, 403);
  });

  it("rejects duplicate category names and lists active categories", async () => {
    const dup = await api(owner, "POST", "/api/expense_categories", {
      categoryName: `Rent ${stamp}`,
    });
    assert.equal(dup.status, 409);

    const list = await api(owner, "GET", "/api/expense_categories");
    const names = (list.body as { categoryName?: string }[]).map(
      (c) => c.categoryName,
    );
    assert.ok(names.includes(`Rent ${stamp}`));
  });
});
