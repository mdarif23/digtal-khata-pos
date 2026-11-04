/**
 * Expense module Phase 5 integration tests — analytics aggregates:
 * totals/average/status counts, monthly comparison, trend series,
 * category/method/location breakdowns, voided exclusion, scoping.
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

interface AnalyticsBody {
  range?: { from: string; to: string; granularity: string };
  totals?: {
    totalCount: number;
    totalAmount: number;
    totalPaid: number;
    totalDue: number;
    averageAmount: number;
    unpaidCount: number;
    partialCount: number;
    paidCount: number;
  };
  comparison?: {
    currentAmount: number;
    previousAmount: number;
    growthPercent: number | null;
  };
  series?: Array<{ bucket: string; count: number; amount: number; paid: number }>;
  categories?: Array<{
    categoryId: number | null;
    categoryName: string | null;
    amount: number;
    count: number;
  }>;
  paymentMethods?: Array<{ method: string | null; amount: number; count: number }>;
  locations?: Array<{
    locationId: number | null;
    locationName: string | null;
    amount: number;
    count: number;
  }>;
}

describe("expenses phase 5 integration", { skip: !runIntegration }, () => {
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
    `expan-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

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
        fullName: "Expense An Test",
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
  const stamp = Date.now();

  let owner: Ctx;
  let other: Ctx;
  let locationA = 0;
  let locationB = 0;
  let categoryId = 0;

  before(async () => {
    owner = await registerAndCreateBusiness(
      `expan-owner-${stamp}@example.test`,
      "Expense An Co",
    );
    other = await registerAndCreateBusiness(
      `expan-other-${stamp}@example.test`,
      "Expense An Other Co",
    );
    for (const ctx of [owner, other]) {
      const loc = await api(ctx, "POST", "/api/locations", {
        name: ctx === owner ? "An Main" : "Other An Main",
        isDefault: true,
      });
      assert.equal(loc.status, 201);
    }
    const locB = await api(owner, "POST", "/api/locations", {
      name: "An Branch",
    });
    assert.equal(locB.status, 201);
    const locARow = await api(owner, "GET", "/api/locations");
    // Default location first created is A; branch id from its response.
    locationB = (locB.body as { data?: { id?: number } }).data?.id ?? 0;
    const rows = (
      locARow.body as { data?: Array<{ id: number; name: string }> }
    ).data ?? [];
    locationA = rows.find((l) => l.name === "An Main")?.id ?? 0;
    assert.ok(locationA);
    assert.ok(locationB);

    const cat = await api(owner, "POST", "/api/expense_categories", {
      categoryName: `Analytics Cat ${stamp}`,
    });
    assert.equal(cat.status, 201);
    categoryId = (cat.body as { id?: number }).id ?? 0;
  });

  it("aggregates totals, status counts, average and breakdowns", async () => {
    // Seed: 3 expenses on A (100 paid Cash, 200 partial 50 Mobile, 50 unpaid Card)
    // plus 1 on B (150 paid Mobile) and 1 voided (999).
    const seeds: Array<[number, number, string, string, number | null]> = [
      [100, 0, "Cash", daysAgo(1), null], // amount, initial, method, date, category
      [200, 50, "Mobile", daysAgo(3), categoryId],
      [50, 0, "Card", daysAgo(2), categoryId],
      [150, 0, "Mobile", daysAgo(1), null], // created with explicit location below
    ];
    for (const [amount, initial, method, date, cat] of seeds) {
      const res = await api(
        owner,
        "POST",
        "/api/expenses",
        {
          title: `Analytics seed ${amount}`,
          expense_date: date,
          amount,
          category_id: cat,
          payment_method: method,
          ...(initial
            ? { initial_payment: { amount: initial } }
            : { record_as: "unpaid" }),
        },
        locationA,
      );
      assert.equal(res.status, 201);
    }
    const branch = await api(
      owner,
      "POST",
      "/api/expenses",
      {
        title: "Analytics branch 150",
        expense_date: today(),
        amount: 150,
        category_id: null,
        payment_method: "Mobile",
        record_as: "unpaid",
      },
      locationB,
    );
    assert.equal(branch.status, 201);
    const branchPaid = await api(
      owner,
      "POST",
      `/api/expenses/${String((branch.body as { id?: number }).id)}/payments`,
      { amount: 150, payment_method: "Mobile" },
      locationB,
    );
    assert.equal(branchPaid.status, 201);
    const voided = await api(
      owner,
      "POST",
      "/api/expenses",
      {
        title: "Analytics voided 999",
        expense_date: today(),
        amount: 999,
        category_id: null,
        payment_method: "Cash",
      },
      locationA,
    );
    const voidedId = (voided.body as { id?: number }).id as number;
    await api(owner, "DELETE", `/api/expenses/${String(voidedId)}`, undefined, locationA);

    const res = await api(owner, "GET", "/api/expenses/analytics", undefined, locationA);
    assert.equal(res.status, 200);
    const body = (res.body as { success?: boolean; data?: AnalyticsBody }).data;
    assert.ok(body);

    // Totals exclude the voided 999 and include both locations:
    // A = 100 + 200 + 50 + 150, B = 150 → 650 across 5 rows. Paid = the
    // partial 50 + the fully-paid branch 150 (all other seeds are unpaid).
    assert.equal(body.totals?.totalCount, 5);
    assert.equal(body.totals?.totalAmount, 650);
    assert.equal(body.totals?.totalPaid, 200);
    assert.equal(body.totals?.totalDue, 450);
    assert.equal(body.totals?.averageAmount, 130);
    assert.equal(body.totals?.paidCount, 1);
    assert.equal(body.totals?.partialCount, 1);
    assert.equal(body.totals?.unpaidCount, 3);

    // Comparison: current month only (seeds are this month) — 650 vs previous
    // month 0 → growth null (previous = 0 convention matches the dashboard).
    assert.equal(body.comparison?.currentAmount, 650);
    assert.equal(body.comparison?.previousAmount, 0);
    assert.equal(body.comparison?.growthPercent, null);

    // Category breakdown: named category = 250 (200 + 50), uncategorized 400.
    const named = body.categories?.find((c) => c.categoryId === categoryId);
    assert.equal(named?.amount, 250);
    assert.equal(named?.count, 2);
    const uncategorized = body.categories?.find((c) => c.categoryId === null);
    assert.equal(uncategorized?.amount, 400);

    // Payment method breakdown: Mobile 500, Cash 100, Card 50.
    const mobile = body.paymentMethods?.find((m) => m.method === "Mobile");
    assert.equal(mobile?.amount, 500);
    const cash = body.paymentMethods?.find((m) => m.method === "Cash");
    assert.equal(cash?.amount, 100);
    const card = body.paymentMethods?.find((m) => m.method === "Card");
    assert.equal(card?.amount, 50);

    // Location breakdown: A 500, B 150.
    const locA = body.locations?.find((l) => l.locationId === locationA);
    assert.equal(locA?.amount, 500);
    const locB = body.locations?.find((l) => l.locationId === locationB);
    assert.equal(locB?.amount, 150);

    // Series has at least one bucket this month with the full amount.
    assert.ok((body.series?.length ?? 0) >= 1);
    const thisMonthBucket = body.series?.find(
      (s) => s.bucket.slice(0, 7) === today().slice(0, 7),
    );
    assert.equal(thisMonthBucket?.amount, 650);
  });

  it("respects the location filter and explicit date ranges", async () => {
    // Scope via the ?locationId query param (the X-Location-Id header only
    // sets the default context; analytics scoping is query-driven).
    const onlyB = await api(
      owner,
      "GET",
      `/api/expenses/analytics?granularity=day&locationId=${String(locationB)}`,
      undefined,
      locationB,
    );
    const b = (onlyB.body as { data?: AnalyticsBody }).data;
    assert.equal(b?.totals?.totalAmount, 150);
    assert.equal(b?.locations?.length, 1);
    assert.equal(b?.locations?.[0]?.locationId, locationB);

    // Date range that excludes everything seeded (all seeded this month).
    const empty = await api(
      owner,
      "GET",
      "/api/expenses/analytics?date_from=2000-01-01&date_to=2000-01-31&locationId=all",
      undefined,
      locationA,
    );
    const e = (empty.body as { data?: AnalyticsBody }).data;
    assert.equal(e?.totals?.totalCount, 0);
    assert.equal(e?.totals?.totalAmount, 0);
    assert.equal(e?.totals?.averageAmount, 0);
  });

  it("keeps analytics business-isolated and permission-gated", async () => {
    const foreign = await api(other, "GET", "/api/expenses/analytics");
    const f = (foreign.body as { data?: AnalyticsBody }).data;
    assert.equal(f?.totals?.totalCount, 0);
    assert.equal(f?.totals?.totalAmount, 0);

    const roles = await api(owner, "GET", "/api/roles");
    const rolesBody = roles.body as { data?: { id: number; slug: string }[] };
    const cashierRole = (rolesBody.data ?? []).find((r) => r.slug === "cashier");
    assert.ok(cashierRole);
    const email = `expan-cashier-${stamp}@example.test`;
    const created = await api(owner, "POST", "/api/users", {
      fullName: "An Cashier",
      email,
      password: "strong-password-123",
      roleIds: [cashierRole.id],
    });
    assert.equal(created.status, 201);
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
    const denied = await api(
      cashier,
      "GET",
      "/api/expenses/analytics",
      undefined,
      locationA,
    );
    assert.equal(denied.status, 403);
  });
});
