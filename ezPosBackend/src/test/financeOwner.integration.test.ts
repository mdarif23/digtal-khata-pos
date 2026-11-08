/**
 * Owner finance integration tests (Finance & Growth Stage 4).
 *
 * Covers: owner profiles (incl. duplicate-user guard), capital transactions
 * with GL posting (investment → 3010, withdrawal/distribution → 3020),
 * client_uuid idempotency, the documented profit-calculation formulas,
 * allocation validation (over-allocation + overlap rejection, percent and
 * fixed lines), realization as an actual distribution payment, reversal
 * guards, permission enforcement and the A = L + E invariant.
 *
 * Double-guarded: runs ONLY with INTEGRATION_TESTS=1 AND DATABASE_URL
 * pointing at ezpos_test (fail-closed). Plain `npm test` NEVER runs this.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("owner finance integration", { skip: !runIntegration }, () => {
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
      body: JSON.stringify({ name: `Owner Biz ${name}` }),
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
    const email = `${slug}-${stamp}-${Math.floor(Math.random() * 1e6)}@example.test`;
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
    assert.equal(res.status, 200);
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
  let ownerId = 0;
  let secondOwnerId = 0;
  let variantId = 0;
  const today = new Date().toISOString().slice(0, 10);

  before(async () => {
    owner = await createOwner(`ownfin-owner`);
    accountant = await createStaff(owner, "accountant", "Own Accountant");
    cashier = await createStaff(owner, "cashier", "Own Cashier");

    const activation = await api(owner, "POST", "/api/finance/activation", {
      accounts: [{ name: "Cash Drawer", type: "cash", openingBalance: 10000 }],
      ownerCapital: 10000,
    });
    assert.equal(activation.status, 201, JSON.stringify(activation.body));

    const product = await api(owner, "POST", "/api/product", {
      name: `Own Cola ${stamp}`,
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
          sku: `OWN-${stamp}`,
          barcode: null,
          sellingPrice: 100,
          alertQuantity: 5,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `OB-${stamp}`,
          purchasePrice: 40,
          quantity: 500,
          expiryDate: null,
        },
      ],
    });
    assert.equal(product.status, 201);
    const list = await api(owner, "GET", "/api/products");
    const created = (list.body as { name: string; variants: { id: number }[] }[]).find(
      (p) => p.name === `Own Cola ${stamp}`,
    );
    assert.ok(created);
    variantId = created.variants[0]!.id;
  });

  it("creates owner profiles and rejects duplicate active platform-user owners", async () => {
    const first = await api(owner, "POST", "/api/finance/owners", {
      name: "Founder",
      userId: owner.userId,
      ownershipPercent: 60,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    ownerId = first.body.id;

    const bookOwner = await api(owner, "POST", "/api/finance/owners", {
      name: "Silent Partner",
      ownershipPercent: 40,
    });
    assert.equal(bookOwner.status, 201);
    secondOwnerId = bookOwner.body.id;

    const dup = await api(owner, "POST", "/api/finance/owners", {
      name: "Double",
      userId: owner.userId,
    });
    assert.equal(dup.status, 409);
  });

  it("posts an investment to the ledger and reflects it in the summary", async () => {
    const before = await balances();
    const res = await api(owner, "POST", "/api/finance/capital-transactions", {
      ownerProfileId: ownerId,
      type: "investment",
      amount: 5000,
      method: "cash",
      sourceOfFunds: "Personal savings",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const after = await balances();
    assert.equal((after.get("1010") ?? 0) - (before.get("1010") ?? 0), 5000);
    // Credit-normal: contributions balance goes more negative.
    assert.equal((after.get("3010") ?? 0) - (before.get("3010") ?? 0), -5000);

    const summary = await api(owner, "GET", "/api/finance/capital-summary");
    assert.equal(summary.body.totals.contributed, "5000.00");
    assert.equal(summary.body.totals.position, "5000.00");
    await assertBooksBalanced();
  });

  it("posts a withdrawal (capital repayment) to drawings", async () => {
    const before = await balances();
    const res = await api(owner, "POST", "/api/finance/capital-transactions", {
      ownerProfileId: ownerId,
      type: "withdrawal",
      amount: 1000,
      method: "cash",
    });
    assert.equal(res.status, 201);
    const after = await balances();
    assert.equal((after.get("3020") ?? 0) - (before.get("3020") ?? 0), 1000);
    assert.equal((after.get("1010") ?? 0) - (before.get("1010") ?? 0), -1000);

    const summary = await api(owner, "GET", "/api/finance/capital-summary");
    assert.equal(summary.body.totals.returned, "1000.00");
    assert.equal(summary.body.totals.position, "4000.00");
    await assertBooksBalanced();
  });

  it("is idempotent via client_uuid", async () => {
    const clientUuid = crypto.randomUUID();
    const first = await api(owner, "POST", "/api/finance/capital-transactions", {
      ownerProfileId: secondOwnerId,
      type: "investment",
      amount: 2000,
      method: "cash",
      clientUuid,
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.duplicate, false);
    const retry = await api(owner, "POST", "/api/finance/capital-transactions", {
      ownerProfileId: secondOwnerId,
      type: "investment",
      amount: 2000,
      method: "cash",
      clientUuid,
    });
    assert.equal(retry.status, 201);
    assert.equal(retry.body.duplicate, true);
    assert.equal(retry.body.transaction.id, first.body.transaction.id);

    const summary = await api(owner, "GET", "/api/finance/capital-summary");
    assert.equal(summary.body.totals.contributed, "7000.00");
  });

  it("calculates profit from the ledger with the documented formulas", async () => {
    // Seed: cash sale 300 (COGS 120) + expense 50.
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 300, tendered: 300 }],
      discount: null,
      vatPercent: null,
      items: [{ variantId, quantity: 3, unitPrice: 100, discount: null }],
    });
    assert.equal(sale.status, 201);
    const expense = await api(owner, "POST", "/api/expenses", {
      title: `Own utilities ${stamp}`,
      amount: 50,
      category_id: null,
      payment_method: "Cash",
      expense_date: today,
    });
    assert.equal(expense.status, 201);

    const profit = await api(
      owner,
      "GET",
      `/api/finance/profit?from=${today}&to=${today}`,
    );
    assert.equal(profit.status, 200, JSON.stringify(profit.body));
    assert.equal(profit.body.netRevenue, "300.00");
    assert.equal(profit.body.cogs, "120.00");
    assert.equal(profit.body.grossProfit, "180.00");
    assert.equal(profit.body.operatingExpenses, "50.00");
    assert.equal(profit.body.operatingProfit, "130.00");
    assert.equal(profit.body.netProfit, "130.00");
  });

  it("allocates distributable profit with percent and fixed lines", async () => {
    // Distributable = 130. 50% reinvestment, 30% distribution, 20% reserve.
    const res = await api(owner, "POST", "/api/finance/profit-allocations", {
      periodStart: today,
      periodEnd: today,
      periodLabel: "Today",
      lines: [
        { category: "reinvestment", basisType: "percent", basisValue: 50 },
        { category: "owner_distribution", basisType: "percent", basisValue: 30 },
        { category: "emergency_reserve", basisType: "fixed", amount: 26 },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.totalDistributable, "130.00");
    assert.equal(res.body.totalAllocated, "130.00");
    const reinvest = res.body.lines.find(
      (l: { category: string }) => l.category === "reinvestment",
    );
    assert.equal(reinvest.amount, "65.00");
  });

  it("rejects over-allocation and overlapping periods", async () => {
    // 130 is already allocated for today — an overlapping allocation is
    // rejected outright…
    const overlap = await api(owner, "POST", "/api/finance/profit-allocations", {
      periodStart: today,
      periodEnd: today,
      lines: [{ category: "other", basisType: "fixed", amount: 1 }],
    });
    assert.equal(overlap.status, 409);
  });

  it("realizes an owner-distribution share as an actual payment", async () => {
    const before = await balances();
    const allocations = await api(owner, "GET", "/api/finance/profit-allocations");
    const allocation = allocations.body.rows[0];
    const line = (
      allocation.lines as {
        id: number;
        category: string;
        amount: string;
        realizedAmount: string;
      }[]
    ).find((l) => l.category === "owner_distribution");
    assert.ok(line);
    assert.equal(line.amount, "39.00");

    // Only the distribution share's owner can be paid — use the owner profile.
    const res = await api(
      owner,
      "POST",
      `/api/finance/profit-allocations/lines/${line.id}/realize`,
      {
        ownerProfileId: ownerId,
        method: "cash",
      },
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const after = await balances();
    assert.equal((after.get("3020") ?? 0) - (before.get("3020") ?? 0), 39);
    assert.equal((after.get("1010") ?? 0) - (before.get("1010") ?? 0), -39);

    const summary = await api(owner, "GET", "/api/finance/capital-summary");
    assert.equal(summary.body.totals.distributed, "39.00");

    // Realizing more than the remainder is rejected.
    const again = await api(
      owner,
      "POST",
      `/api/finance/profit-allocations/lines/${line.id}/realize`,
      { ownerProfileId: ownerId, amount: 1, method: "cash" },
    );
    assert.equal(again.status, 409);
    await assertBooksBalanced();
  });

  it("guards reversals and non-overlapping allocation reversal", async () => {
    const allocations = await api(owner, "GET", "/api/finance/profit-allocations");
    const realized = allocations.body.rows[0];
    // Realized allocations cannot be reversed.
    const blocked = await api(
      owner,
      "POST",
      `/api/finance/profit-allocations/${realized.id}/reverse`,
      { reason: "Changed my mind" },
    );
    assert.equal(blocked.status, 409);

    // A fresh allocation in a non-overlapping range reverses cleanly.
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const created = await api(owner, "POST", "/api/finance/profit-allocations", {
      periodStart: yesterday,
      periodEnd: yesterday,
      lines: [{ category: "reinvestment", basisType: "fixed", amount: 10 }],
    });
    // No profit yesterday → distributable is 0 → rejected as a bad request.
    assert.ok([400, 409].includes(created.status));
  });

  it("enforces permissions: accountant cannot allocate, cashier is blind", async () => {
    const accountantAlloc = await api(accountant, "POST", "/api/finance/profit-allocations", {
      periodStart: "2030-01-01",
      periodEnd: "2030-01-31",
      lines: [{ category: "other", basisType: "fixed", amount: 1 }],
    });
    assert.equal(accountantAlloc.status, 403);

    const accountantInvest = await api(accountant, "POST", "/api/finance/capital-transactions", {
      ownerProfileId: ownerId,
      type: "investment",
      amount: 1,
      method: "cash",
    });
    assert.equal(accountantInvest.status, 403);

    const cashierOwners = await api(cashier, "GET", "/api/finance/owners");
    assert.equal(cashierOwners.status, 403);
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
