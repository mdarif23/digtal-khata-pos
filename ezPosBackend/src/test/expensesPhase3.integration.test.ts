/**
 * Expense module Phase 3 integration tests — category lifecycle:
 * create with presentation fields, edit, archive, restore, active-name
 * uniqueness, historical expense preservation, tenancy + permissions.
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

interface CategoryRow {
  id: number;
  categoryName: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  archivedAt: string | null;
}

describe("expenses phase 3 integration", { skip: !runIntegration }, () => {
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
    `expcat-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

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
        fullName: "Expense Cat Test",
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
    const bizBody = (await biz.json()) as { business?: { id?: number } };
    const businessId = bizBody.business?.id;
    assert.ok(businessId);

    return {
      token,
      businessId,
      userId: loginBody.user.id,
      email,
    };
  }

  const today = () => new Date().toISOString().slice(0, 10);
  const stamp = Date.now();

  let owner: Ctx;
  let other: Ctx;
  let accountant: Ctx;
  let locationA = 0;
  let categoryId = 0;

  before(async () => {
    owner = await registerAndCreateBusiness(
      `expcat-owner-${stamp}@example.test`,
      "Expense Cat Co",
    );
    other = await registerAndCreateBusiness(
      `expcat-other-${stamp}@example.test`,
      "Expense Cat Other Co",
    );

    let ownerLocationId = 0;
    for (const ctx of [owner, other]) {
      const loc = await api(ctx, "POST", "/api/locations", {
        name: ctx === owner ? "Cat Main" : "Other Cat Main",
        isDefault: true,
      });
      assert.equal(loc.status, 201);
      if (ctx === owner) {
        ownerLocationId = (loc.body as { data?: { id?: number } }).data?.id ?? 0;
      }
    }
    locationA = ownerLocationId;

    // Accountant (expenses.edit — category management gate) with a location.
    const roles = await api(owner, "GET", "/api/roles");
    const rolesBody = roles.body as { data?: { id: number; slug: string }[] };
    const accountantRole = (rolesBody.data ?? []).find(
      (r) => r.slug === "accountant",
    );
    assert.ok(accountantRole);
    const accEmail = `expcat-acc-${stamp}@example.test`;
    const createdUser = await api(owner, "POST", "/api/users", {
      fullName: "Cat Accountant",
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

  it("creates a category with description, color and icon", async () => {
    const res = await api(owner, "POST", "/api/expense_categories", {
      categoryName: `Utilities ${stamp}`,
      description: "Electricity, water and gas",
      color: "#2563eb",
      icon: "zap",
    }, locationA);
    assert.equal(res.status, 201);
    const body = res.body as CategoryRow;
    assert.equal(body.categoryName, `Utilities ${stamp}`);
    assert.equal(body.description, "Electricity, water and gas");
    assert.equal(body.color, "#2563eb");
    assert.equal(body.icon, "zap");
    assert.equal(body.archivedAt, null);
    categoryId = body.id;
  });

  it("rejects invalid colors and duplicate active names", async () => {
    const badColor = await api(owner, "POST", "/api/expense_categories", {
      categoryName: `Bad Color ${stamp}`,
      color: "blue",
    }, locationA);
    assert.equal(badColor.status, 400);

    const dup = await api(owner, "POST", "/api/expense_categories", {
      categoryName: `Utilities ${stamp}`,
    }, locationA);
    assert.equal(dup.status, 409);
  });

  it("edits name, description and presentation fields", async () => {
    const res = await api(
      accountant,
      "PATCH",
      `/api/expense_categories/${String(categoryId)}`,
      {
        categoryName: `Utilities edited ${stamp}`,
        description: "Updated description",
        color: "#16a34a",
        icon: "droplets",
      },
      locationA,
    );
    assert.equal(res.status, 200);
    const body = res.body as CategoryRow;
    assert.equal(body.categoryName, `Utilities edited ${stamp}`);
    assert.equal(body.color, "#16a34a");

    // Renaming onto another active category's name conflicts.
    const blocker = await api(owner, "POST", "/api/expense_categories", {
      categoryName: `Blocker ${stamp}`,
    }, locationA);
    assert.equal(blocker.status, 201);
    const dup = await api(
      owner,
      "PATCH",
      `/api/expense_categories/${String(categoryId)}`,
      { categoryName: `Blocker ${stamp}` },
      locationA,
    );
    assert.equal(dup.status, 409);
  });

  it("archives a category, keeps historical expenses labeled, and frees the name", async () => {
    // Reference the category from an expense first.
    const expense = await api(
      owner,
      "POST",
      "/api/expenses",
      {
        title: "Category history expense",
        expense_date: today(),
        amount: 80,
        category_id: categoryId,
        payment_method: "Cash",
      },
      locationA,
    );
    assert.equal(expense.status, 201);

    const archived = await api(
      owner,
      "POST",
      `/api/expense_categories/${String(categoryId)}/archive`,
      undefined,
      locationA,
    );
    assert.equal(archived.status, 200);
    const archivedBody = archived.body as { data?: CategoryRow };
    assert.ok(archivedBody.data?.archivedAt);

    // Default list excludes it; include_archived shows it.
    const active = await api(owner, "GET", "/api/expense_categories", undefined, locationA);
    const activeNames = (active.body as CategoryRow[]).map((c) => c.categoryName);
    assert.ok(!activeNames.includes(`Utilities edited ${stamp}`));

    const all = await api(
      owner,
      "GET",
      "/api/expense_categories?include_archived=true",
      undefined,
      locationA,
    );
    const archivedRow = (all.body as CategoryRow[]).find(
      (c) => c.id === categoryId,
    );
    assert.ok(archivedRow?.archivedAt);

    // Historical expense rows keep the category label.
    const expenseList = await api(
      owner,
      "GET",
      "/api/expenses?search=Category%20history",
      undefined,
      locationA,
    );
    const rows = (expenseList.body as { data?: { categoryName?: string | null }[] })
      .data ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.categoryName, `Utilities edited ${stamp}`);

    // The freed name can be re-created as a fresh active category.
    const recreated = await api(owner, "POST", "/api/expense_categories", {
      categoryName: `Utilities edited ${stamp}`,
    }, locationA);
    assert.equal(recreated.status, 201);
    const recreatedId = (recreated.body as CategoryRow).id;

    // Restoring while the name is taken conflicts.
    const restoreConflict = await api(
      owner,
      "POST",
      `/api/expense_categories/${String(categoryId)}/restore`,
      undefined,
      locationA,
    );
    assert.equal(restoreConflict.status, 409);

    // Archiving the replacement frees the name again; restore then works.
    const reArchive = await api(
      owner,
      "POST",
      `/api/expense_categories/${String(recreatedId)}/archive`,
      undefined,
      locationA,
    );
    assert.equal(reArchive.status, 200);
    const restored = await api(
      owner,
      "POST",
      `/api/expense_categories/${String(categoryId)}/restore`,
      undefined,
      locationA,
    );
    assert.equal(restored.status, 200);
    assert.equal((restored.body as { data?: CategoryRow }).data?.archivedAt, null);
  });

  it("keeps category management business-isolated", async () => {
    const foreign = await api(
      other,
      "PATCH",
      `/api/expense_categories/${String(categoryId)}`,
      { categoryName: "Hijacked" },
    );
    assert.equal(foreign.status, 404);

    const foreignArchive = await api(
      other,
      "POST",
      `/api/expense_categories/${String(categoryId)}/archive`,
    );
    assert.equal(foreignArchive.status, 404);
  });

  it("enforces expenses.edit for the lifecycle and expenses.view for reads", async () => {
    const roles = await api(owner, "GET", "/api/roles");
    const rolesBody = roles.body as { data?: { id: number; slug: string }[] };
    const cashierRole = (rolesBody.data ?? []).find((r) => r.slug === "cashier");
    assert.ok(cashierRole);

    const email = `expcat-cashier-${stamp}@example.test`;
    const created = await api(owner, "POST", "/api/users", {
      fullName: "Cat Cashier",
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

    const deniedEdit = await api(
      cashier,
      "PATCH",
      `/api/expense_categories/${String(categoryId)}`,
      { categoryName: "Nope" },
      locationA,
    );
    assert.equal(deniedEdit.status, 403);

    const deniedArchive = await api(
      cashier,
      "POST",
      `/api/expense_categories/${String(categoryId)}/archive`,
      undefined,
      locationA,
    );
    assert.equal(deniedArchive.status, 403);

    const deniedRead = await api(
      cashier,
      "GET",
      "/api/expense_categories",
      undefined,
      locationA,
    );
    assert.equal(deniedRead.status, 403);
  });
});
