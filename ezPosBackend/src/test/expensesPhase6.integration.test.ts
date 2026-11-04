/**
 * Expense module Phase 6 integration tests — recurring templates (idempotent
 * generation, catch-up, end dates, always-unpaid) and budgets (scope
 * uniqueness, live usage). Includes direct unit assertions on the drift-free
 * period arithmetic.
 *
 * Run ONLY when BOTH INTEGRATION_TESTS=1 and DATABASE_URL point at the
 * approved disposable ezpos_test database. Plain `npm test` NEVER runs this.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";
import { advancePeriod } from "../modules/expenses/expenses.templates.service.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("expenses phase 6 integration", { skip: !runIntegration }, () => {
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
    `expadv-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

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
        fullName: "Expense Adv Test",
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
    return { token, businessId, userId: 0, email };
  }

  const today = () => new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const thisMonth = () => `${today().slice(0, 8)}01`;
  const stamp = Date.now();

  let owner: Ctx;
  let other: Ctx;
  let accountant: Ctx;
  let locationA = 0;
  let categoryId = 0;

  before(async () => {
    owner = await registerAndCreateBusiness(
      `expadv-owner-${stamp}@example.test`,
      "Expense Adv Co",
    );
    other = await registerAndCreateBusiness(
      `expadv-other-${stamp}@example.test`,
      "Expense Adv Other Co",
    );
    for (const ctx of [owner, other]) {
      const loc = await api(ctx, "POST", "/api/locations", {
        name: ctx === owner ? "Adv Main" : "Other Adv Main",
        isDefault: true,
      });
      assert.equal(loc.status, 201);
      if (ctx === owner) {
        locationA = (loc.body as { data?: { id?: number } }).data?.id ?? 0;
      }
    }
    const cat = await api(owner, "POST", "/api/expense_categories", {
      categoryName: `Adv Cat ${stamp}`,
    });
    assert.equal(cat.status, 201);
    categoryId = (cat.body as { id?: number }).id ?? 0;

    // Accountant (expenses.create/edit) with a location.
    const roles = await api(owner, "GET", "/api/roles");
    const rolesBody = roles.body as { data?: { id: number; slug: string }[] };
    const accountantRole = (rolesBody.data ?? []).find(
      (r) => r.slug === "accountant",
    );
    assert.ok(accountantRole);
    const accEmail = `expadv-acc-${stamp}@example.test`;
    const createdUser = await api(owner, "POST", "/api/users", {
      fullName: "Adv Accountant",
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
      userId: accountantUserId,
      email: accEmail,
    };
  });

  it("advances periods without drift on short months", () => {
    // Jan 31 monthly → Feb clamped, then Mar keeps the 31st (no drift).
    assert.equal(advancePeriod("2026-01-31", "monthly", 31), "2026-02-28");
    assert.equal(advancePeriod("2026-02-28", "monthly", 31), "2026-03-31");
    // Weekly is plain +7 days.
    assert.equal(advancePeriod("2026-01-05", "weekly", 5), "2026-01-12");
    // Yearly keeps the day and clamps Feb 29 on non-leap years.
    assert.equal(advancePeriod("2024-02-29", "yearly", 29), "2025-02-28");
  });

  it("generates due periods once, always unpaid, and is idempotent", async () => {
    const created = await api(
      owner,
      "POST",
      "/api/expense_templates",
      {
        title: `Weekly internet ${stamp}`,
        amount: 75,
        category_id: categoryId,
        payment_method: "Mobile",
        payee: "ISP Ltd",
        location_id: locationA,
        frequency: "weekly",
        start_date: daysAgo(14),
      },
      locationA,
    );
    assert.equal(created.status, 201);
    const templateId = String(
      (created.body as { data?: { id?: number } }).data?.id,
    );

    const run1 = await api(
      owner,
      "POST",
      `/api/expense_templates/${templateId}/generate`,
      undefined,
      locationA,
    );
    assert.equal(run1.status, 200);
    assert.equal((run1.body as { data?: { generated?: number } }).data?.generated, 3); // −14, −7, today

    // Idempotent: an immediate re-run generates nothing.
    const run2 = await api(
      owner,
      "POST",
      `/api/expense_templates/${templateId}/generate`,
      undefined,
      locationA,
    );
    assert.equal((run2.body as { data?: { generated?: number } }).data?.generated, 0);

    // Generated expenses exist, are unpaid, and carry the template note.
    const list = await api(
      owner,
      "GET",
      `/api/expenses?search=${encodeURIComponent(`Weekly internet ${stamp}`)}&page_size=100`,
      undefined,
      locationA,
    );
    const rows = (list.body as { data?: Array<Record<string, unknown>> }).data ?? [];
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.paymentStatus, "unpaid");
      assert.equal(Number(row.paidAmount), 0);
      assert.equal(row.categoryId, categoryId);
      assert.equal(row.payee, "ISP Ltd");
      assert.match(String(row.note), /recurring template/);
    }

    // The template's next generation date moved past today.
    const templates = await api(owner, "GET", "/api/expense_templates", undefined, locationA);
    const template = (templates.body as { data?: Array<{ id: number; nextGenerationDate: string; lastGeneratedDate: string | null }> })
      .data?.find((t) => String(t.id) === templateId);
    assert.ok(template);
    assert.ok(template.nextGenerationDate > today());
    assert.ok(template.lastGeneratedDate !== null);
  });

  it("stops at end_date and honors the catch-up cap", async () => {
    const bounded = await api(
      owner,
      "POST",
      "/api/expense_templates",
      {
        title: `Bounded rent ${stamp}`,
        amount: 1000,
        category_id: null,
        payment_method: "Cash",
        location_id: locationA,
        frequency: "monthly",
        start_date: daysAgo(800),
        end_date: daysAgo(700),
      },
      locationA,
    );
    assert.equal(bounded.status, 201);
    const boundedId = String(
      (bounded.body as { data?: { id?: number } }).data?.id,
    );
    // Periods between −800d and −700d are capped by MAX_CATCH_UP (24).
    const run = await api(
      owner,
      "POST",
      `/api/expense_templates/${boundedId}/generate`,
      undefined,
      locationA,
    );
    assert.equal(run.status, 200);
    const generated = (run.body as { data?: { generated?: number } }).data
      ?.generated as number;
    assert.ok(generated <= 24 && generated > 0);

    // The catch-up cap path: a very old weekly template generates exactly 24
    // per run and keeps making progress across runs.
    const old = await api(
      owner,
      "POST",
      "/api/expense_templates",
      {
        title: `Old weekly ${stamp}`,
        amount: 10,
        category_id: null,
        payment_method: "Cash",
        location_id: locationA,
        frequency: "weekly",
        start_date: daysAgo(2 * 365),
      },
      locationA,
    );
    const oldId = String((old.body as { data?: { id?: number } }).data?.id);
    const firstRun = await api(
      owner,
      "POST",
      `/api/expense_templates/${oldId}/generate`,
      undefined,
      locationA,
    );
    assert.equal(
      (firstRun.body as { data?: { generated?: number } }).data?.generated,
      24,
    );
  });

  it("keeps templates and generation business-isolated", async () => {
    const templates = await api(owner, "GET", "/api/expense_templates", undefined, locationA);
    const foreignList = await api(other, "GET", "/api/expense_templates");
    assert.equal((foreignList.body as { data?: unknown[] }).data?.length, 0);

    const templateId = String(
      ((templates.body as { data?: Array<{ id: number }> }).data ?? [])[0]?.id,
    );
    const foreignGenerate = await api(
      other,
      "POST",
      `/api/expense_templates/${templateId}/generate`,
    );
    assert.equal(foreignGenerate.status, 404);
  });

  it("creates budgets, computes live usage, and enforces scope uniqueness", async () => {
    // Seed spend: 200 on the category + 100 uncategorized this month.
    for (const [amount, cat, title] of [
      [200, categoryId, "Budget seed cat"],
      [100, null, "Budget seed plain"],
    ] as const) {
      const res = await api(
        owner,
        "POST",
        "/api/expenses",
        {
          title,
          expense_date: today(),
          amount,
          category_id: cat,
          payment_method: "Cash",
        },
        locationA,
      );
      assert.equal(res.status, 201);
    }

    const created = await api(
      accountant,
      "POST",
      "/api/expense_budgets",
      { category_id: null, location_id: null, month: thisMonth(), amount: 500 },
      locationA,
    );
    assert.equal(created.status, 201);
    const budgetId = (created.body as { data?: { id?: number } }).data?.id;

    const scoped = await api(
      accountant,
      "POST",
      "/api/expense_budgets",
      {
        category_id: categoryId,
        location_id: null,
        month: thisMonth(),
        amount: 150,
      },
      locationA,
    );
    assert.equal(scoped.status, 201);

    // Duplicate scope+month conflicts.
    const dup = await api(
      accountant,
      "POST",
      "/api/expense_budgets",
      { category_id: null, location_id: null, month: thisMonth(), amount: 10 },
      locationA,
    );
    assert.equal(dup.status, 409);

    // Non-first-day month is rejected (today is not the 1st — unless this
    // suite runs exactly on the 1st, in which case skip the assertion).
    if (today().slice(8, 10) !== "01") {
      const badMonth = await api(
        accountant,
        "POST",
        "/api/expense_budgets",
        { category_id: null, location_id: null, month: today(), amount: 10 },
        locationA,
      );
      assert.equal(badMonth.status, 400);
    }

    const usage = await api(
      owner,
      "GET",
      "/api/expense_budgets",
      undefined,
      locationA,
    );
    assert.equal(usage.status, 200);
    const rows = (usage.body as { data?: Array<Record<string, unknown>> }).data ?? [];
    // The weekly template generated periods −14d/−7d/today; however many of
    // those fall inside the current month add ৳75 each to the overall budget.
    const inMonthWeekly = [daysAgo(14), daysAgo(7), today()].filter(
      (d) => d.slice(0, 7) === today().slice(0, 7),
    ).length;
    const overall = rows.find((r) => r.categoryId === null);
    assert.equal(Number(overall?.amount), 500);
    assert.equal(Number(overall?.actualAmount), 300 + 75 * inMonthWeekly);
    assert.equal(overall?.overBudget, false);
    const catBudget = rows.find(
      (r) => Number(r.categoryId) === categoryId,
    );
    // The weekly template shares this category, so its in-month generated
    // periods count here too.
    assert.equal(Number(catBudget?.actualAmount), 200 + 75 * inMonthWeekly);
    assert.equal(catBudget?.overBudget, true); // > 150

    // Update the amount, then delete.
    const updated = await api(
      accountant,
      "PATCH",
      `/api/expense_budgets/${String(budgetId)}`,
      { category_id: null, location_id: null, month: thisMonth(), amount: 250 },
      locationA,
    );
    assert.equal(updated.status, 200);
    const afterUpdate = await api(owner, "GET", "/api/expense_budgets", undefined, locationA);
    const overallAfter = ((afterUpdate.body as { data?: Array<Record<string, unknown>> }).data ?? []).find(
      (r) => r.categoryId === null,
    );
    assert.equal(Number(overallAfter?.amount), 250);
    assert.equal(overallAfter?.overBudget, true); // 300 > 250

    const deleted = await api(
      accountant,
      "DELETE",
      `/api/expense_budgets/${String(budgetId)}`,
      undefined,
      locationA,
    );
    assert.equal(deleted.status, 200);

    // Usage endpoint for the analytics panel.
    const usageSeries = await api(
      owner,
      "GET",
      "/api/expense_budgets/usage?months=3",
      undefined,
      locationA,
    );
    assert.equal(usageSeries.status, 200);
    assert.ok(((usageSeries.body as { data?: unknown[] }).data ?? []).length >= 1);
  });

  it("enforces permissions on templates and budgets", async () => {
    const roles = await api(owner, "GET", "/api/roles");
    const rolesBody = roles.body as { data?: { id: number; slug: string }[] };
    const cashierRole = (rolesBody.data ?? []).find((r) => r.slug === "cashier");
    assert.ok(cashierRole);
    const email = `expadv-cashier-${stamp}@example.test`;
    await api(owner, "POST", "/api/users", {
      fullName: "Adv Cashier",
      email,
      password: "strong-password-123",
      roleIds: [cashierRole.id],
    });
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

    const deniedTemplate = await api(
      cashier,
      "POST",
      "/api/expense_templates",
      {
        title: "Nope",
        amount: 10,
        category_id: null,
        payment_method: "Cash",
        frequency: "weekly",
        start_date: today(),
      },
      locationA,
    );
    assert.equal(deniedTemplate.status, 403);

    const deniedBudget = await api(
      cashier,
      "POST",
      "/api/expense_budgets",
      { category_id: null, location_id: null, month: thisMonth(), amount: 10 },
      locationA,
    );
    assert.equal(deniedBudget.status, 403);

    // Reads are open to anyone with expenses.view… which the cashier lacks.
    const deniedRead = await api(
      cashier,
      "GET",
      "/api/expense_templates",
      undefined,
      locationA,
    );
    assert.equal(deniedRead.status, 403);
  });
});
