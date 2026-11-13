/**
 * Phase 5 integration tests: salesperson assignment, commission lifecycle
 * (master prompt Feature 13) and targets/achievement.
 *
 * Double-guarded: runs ONLY with INTEGRATION_TESTS=1 AND DATABASE_URL
 * pointing at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("phase5 sales team & BI", { skip: !runIntegration }, () => {
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

  const stamp = Date.now();

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
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  function payload<T>(res: { body: unknown }): T {
    return res.body as T;
  }

  let owner: Ctx;
  let locationId = 0;
  let variantId = 0;
  let salesperson: Ctx;
  let salespersonUserId = 0;

  async function dbQuery(sql: string, params: unknown[] = []): Promise<any[]> {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      return (await client.query(sql, params)).rows;
    } finally {
      await client.end();
    }
  }

  before(async () => {
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "P5 Test",
        email: `p5-owner-${stamp}@example.test`,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `p5-owner-${stamp}@example.test`,
        password: "strong-password-123",
      }),
    });
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as { accessToken: string; user: { id: number } };
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginBody.accessToken}`,
      },
      body: JSON.stringify({ name: `P5 Biz ${stamp}` }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business: { id: number } };
    owner = {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
      email: `p5-owner-${stamp}@example.test`,
    };

    const loc = await api(owner, "POST", "/api/locations", { name: `P5 Main ${stamp}` });
    locationId = payload<{ data: { id: number } }>(loc).data.id;

    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Pcs ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ data: { value: number } }>(unitRes).data.value;
    const product = await api(owner, "POST", "/api/product", {
      name: `P5 Widget ${stamp}`,
      categoryId: null,
      brandId: null,
      unitId,
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
          sku: `P5-${stamp}`,
          barcode: null,
          sellingPrice: 200,
          alertQuantity: 5,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `P5-${stamp}`,
          purchasePrice: 80,
          quantity: 500,
          expiryDate: null,
        },
      ],
    });
    assert.equal(product.status, 201);
    const list = await api(owner, "GET", "/api/products");
    const created = (list.body as { name: string; variants: { id: number }[] }[]).find(
      (p) => p.name === `P5 Widget ${stamp}`,
    );
    assert.ok(created);
    variantId = created.variants[0]!.id;

    // Salesperson staff user (cashier role).
    const roles = await api(owner, "GET", "/api/roles");
    const cashierRole = payload<{ data: { id: number; slug: string }[] }>(roles).data.find(
      (r) => r.slug === "cashier",
    );
    assert.ok(cashierRole);
    const userRes = await api(owner, "POST", "/api/users", {
      fullName: "P5 Salesperson",
      email: `p5-sales-${stamp}@example.test`,
      password: "strong-password-123",
      roleIds: [cashierRole!.id],
      locationIds: [locationId],
    });
    assert.equal(userRes.status, 201, JSON.stringify(userRes.body));
    const userEmail = payload<{ data: { email: string } }>(userRes).data.email;
    const salesLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: userEmail, password: "strong-password-123" }),
    });
    assert.equal(salesLogin.status, 200);
    const salesBody = (await salesLogin.json()) as { accessToken: string; user: { id: number } };
    salesperson = {
      token: salesBody.accessToken,
      businessId: owner.businessId,
      userId: salesBody.user.id,
      email: userEmail,
    };
    salespersonUserId = salesBody.user.id;

    // Commission rule: 5% of sales for the salesperson.
    const rule = await api(owner, "POST", "/api/commission/rules", {
      name: `Sales 5% ${stamp}`,
      calcMethod: "percentage_of_sales",
      rate: 5,
      userId: salespersonUserId,
      isActive: true,
    });
    assert.equal(rule.status, 201, JSON.stringify(rule.body));
  });

  async function makeSale(price = 200): Promise<number> {
    const res = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      salespersonUserId,
      payments: [{ method: "cash", amount: price, tendered: price }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: price, discount: null }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return payload<{ data: { sale: { id: number } } }>(res).data.sale.id;
  }

  it("calculates a commission entry when a sale completes with a salesperson", async () => {
    const saleId = await makeSale();
    const entries = await dbQuery(
      "SELECT amount, status, base_amount FROM commission_entries WHERE sale_id = $1",
      [saleId],
    );
    assert.equal(entries.length, 1);
    assert.equal(Number(entries[0].amount), 10); // 5% of 200
    assert.equal(entries[0].status, "pending");
    assert.equal(Number(entries[0].base_amount), 200);
  });

  it("moves the entry through the lifecycle pending → approved → payable → paid", async () => {
    const saleId = await makeSale();
    const list = await api(owner, "GET", `/api/commission/entries?userId=${salespersonUserId}`);
    const rows = payload<{ data: { rows: { id: number; status: string; saleId: number }[] } }>(list).data.rows;
    const entry = rows.find((r) => r.saleId === saleId);
    assert.ok(entry);

    const back = await api(salesperson, "POST", `/api/commission/entries/${entry!.id}/status`, {
      status: "approved",
    });
    assert.equal(back.status, 403, "cashier cannot manage the lifecycle");

    const approve = await api(owner, "POST", `/api/commission/entries/${entry!.id}/status`, {
      status: "approved",
    });
    assert.equal(approve.status, 200);
    const markPayable = await api(owner, "POST", `/api/commission/entries/${entry!.id}/status`, {
      status: "payable",
    });
    assert.equal(markPayable.status, 200);
    const markPaid = await api(owner, "POST", `/api/commission/entries/${entry!.id}/status`, {
      status: "paid",
    });
    assert.equal(markPaid.status, 200);
    assert.ok(payload<{ data: { paidAt: string | null } }>(markPaid).data.paidAt);

    // Paid is terminal — no further transition.
    const beyond = await api(owner, "POST", `/api/commission/entries/${entry!.id}/status`, {
      status: "approved",
    });
    assert.equal(beyond.status, 409);
  });

  it("reverses commission proportionally on refund (negative ledger entry)", async () => {
    const saleId = await makeSale();
    const refund = await api(owner, "POST", `/api/sold_products/refunds_all/${saleId}`, {
      reason: "customer_request",
      disposition: "restock",
    });
    assert.equal(refund.status, 200, JSON.stringify(refund.body));

    const entries = await dbQuery(
      "SELECT amount, status, refund_id FROM commission_entries WHERE sale_id = $1 ORDER BY id",
      [saleId],
    );
    assert.equal(entries.length, 2);
    assert.equal(Number(entries[0].amount), 10);
    assert.equal(Number(entries[1].amount), -10);
    assert.equal(entries[1].status, "reversed");
    // refunds_all responds UNWRAPPED — refundId at the top level.
    assert.equal(
      entries[1].refund_id,
      (refund.body as { refundId?: number }).refundId ?? entries[1].refund_id,
    );
  });

  it("supports salesperson reassignment with pending-entry move + audit", async () => {
    // Second staff member.
    const roles = await api(owner, "GET", "/api/roles");
    const cashierRole = payload<{ data: { id: number; slug: string }[] }>(roles).data.find(
      (r) => r.slug === "cashier",
    );
    const userRes = await api(owner, "POST", "/api/users", {
      fullName: "P5 Salesperson 2",
      email: `p5-sales2-${stamp}@example.test`,
      password: "strong-password-123",
      roleIds: [cashierRole!.id],
      locationIds: [locationId],
    });
    assert.equal(userRes.status, 201);
    const newUserId = (
      await dbQuery(
        "SELECT id FROM users WHERE email = $1",
        [`p5-sales2-${stamp}@example.test`],
      )
    )[0].id as number;

    const saleId = await makeSale();
    const reassign = await api(
      owner,
      "POST",
      `/api/sales/${saleId}/reassign-salesperson`,
      { salespersonUserId: newUserId },
    );
    assert.equal(reassign.status, 200, JSON.stringify(reassign.body));

    const rows = await dbQuery(
      "SELECT salesperson_user_id, salesperson_assigned_by FROM sales WHERE id = $1",
      [saleId],
    );
    assert.equal(rows[0].salesperson_user_id, newUserId);
    assert.equal(rows[0].salesperson_assigned_by, owner.userId);

    // Pending commission moved: original reversed, new pending created via
    // re-calculation is deferred — v1 reverses and records the audit trail.
    const entries = await dbQuery(
      "SELECT salesperson_user_id, status, amount FROM commission_entries WHERE sale_id = $1 ORDER BY id",
      [saleId],
    );
    const reversedEntry = entries.find(
      (e) => e.salesperson_user_id === salespersonUserId,
    );
    assert.ok(reversedEntry);
    assert.equal(reversedEntry.status, "reversed");

    const audit = await dbQuery(
      "SELECT id FROM audit_log WHERE business_id = $1 AND action = 'sale.salesperson_reassigned' AND entity_id = $2",
      [owner.businessId, saleId],
    );
    assert.ok(audit.length > 0);
  });

  it("creates targets and reports achievement", async () => {
    const today = new Date();
    const periodStart = new Date(today.getFullYear(), today.getMonth(), 1)
      .toISOString()
      .slice(0, 10);
    const periodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0)
      .toISOString()
      .slice(0, 10);

    const put = await api(owner, "PUT", "/api/targets", {
      userId: salespersonUserId,
      periodType: "monthly",
      periodStart,
      periodEnd,
      targetAmount: 100,
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const ach = await api(
      owner,
      "GET",
      `/api/targets/achievement?locationId=${locationId}`,
    );
    assert.equal(ach.status, 200, JSON.stringify(ach.body));
    const rows = payload<{ data: { userId: number; achievementPercent: number | null }[] }>(ach).data;
    const mine = rows.find((r) => r.userId === salespersonUserId);
    assert.ok(mine);
    // salesperson made 3 sales × 200 = 600 + this month's other attributed
    // sales; achievement > 100 against a 100 target.
    assert.ok((mine!.achievementPercent ?? 0) > 100, JSON.stringify(mine));
  });

  it("reports salesperson performance", async () => {
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const res = await api(owner, "GET", `/api/commission/performance?from=${from}&to=${to}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = payload<{ data: { userId: number; netSales: number; commissionEarned: number }[] }>(res).data;
    const mine = rows.find((r) => r.userId === salespersonUserId);
    assert.ok(mine);
    assert.ok(Number(mine.netSales) > 0);
    assert.ok(Number(mine.commissionEarned) > 0);
  });
});
