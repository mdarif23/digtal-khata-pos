/**
 * P3 Phase 1 (F2): customer credit limits — NULL/0/positive semantics, the
 * createSale 409 gate, authoritative outstanding recomputation, due
 * collection restoring available credit, concurrent due purchases
 * serializing on the customer row lock. Against a REAL PostgreSQL database.
 * Double-guarded like the other suites.
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

describe("creditLimit integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let pg: import("pg").Client | null = null;

  before(async () => {
    const { default: pgDefault } = await import("pg");
    const client = new pgDefault.Client({
      connectionString: process.env.DATABASE_URL,
    });
    await client.connect();
    const db = await client.query("SELECT current_database() AS db");
    if (db.rows[0]?.db !== "ezpos_test") {
      await client.end();
      throw new Error(
        `SAFETY ABORT: connected to "${db.rows[0]?.db}" — integration tests may only run against ezpos_test.`,
      );
    }
    pg = client;
    await ensureRbacSeed();

    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server?.close();
    await pg?.end();
    pg = null;
  });

  interface Ctx {
    token: string;
    businessId: number;
    userId: number;
    email: string;
  }

  const stamp = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  let counter = 0;
  const uniqueEmail = () => `crl-${Date.now()}-${(counter += 1)}@example.test`;

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

  async function dbQuery(sql: string, params: unknown[] = []): Promise<any[]> {
    const rows = await pg!.query(sql, params);
    return rows.rows;
  }

  function payload<T>(res: { body: unknown }): T {
    return (res.body as { data: T }).data;
  }

  let owner: Ctx;
  let variantId = 0;

  before(async () => {
    const ownerEmail = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Credit Owner",
        email: ownerEmail,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ownerEmail, password: "strong-password-123" }),
    });
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as {
      accessToken: string;
      user: { id: number };
    };
    owner = {
      token: loginBody.accessToken,
      businessId: 0,
      userId: loginBody.user.id,
      email: ownerEmail,
    };
    const biz = await api(owner, "POST", "/api/businesses", {
      name: `Credit Co ${stamp}`,
    });
    assert.equal(biz.status, 201);
    owner.businessId = biz.body.business.id;

    const locRes = await api(owner, "POST", "/api/locations", {
      name: `Credit Main ${stamp}`,
    });
    assert.equal(locRes.status, 201);

    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Piece ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ value: number }>(unitRes).value;
    const product = await api(owner, "POST", "/api/product", {
      name: `Credit Cola ${stamp}`,
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
          sku: `CRL-${stamp}`,
          barcode: null,
          sellingPrice: 10,
          alertQuantity: 5,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `CRLB-${stamp}`,
          purchasePrice: 4,
          quantity: 5000,
          expiryDate: null,
        },
      ],
    });
    assert.equal(product.status, 201);
    const list = await api(owner, "GET", "/api/products");
    const created = (
      list.body as { name: string; variants: { id: number }[] }[]
    ).find((p) => p.name === `Credit Cola ${stamp}`);
    assert.ok(created);
    variantId = created.variants[0]!.id;
  });

  async function createCustomer(
    name: string,
    creditLimit: number | null,
  ): Promise<number> {
    const res = await api(owner, "POST", "/api/customers", {
      name,
      phone: `017${String(Date.now()).slice(-8)}`,
      address: "",
      ...(creditLimit === null ? {} : { creditLimit }),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.id as number;
  }

  function dueSalePayload(customerId: number, total: number, cash: number) {
    return {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [
        { method: "cash", amount: cash, tendered: cash },
        { method: "due", amount: total - cash },
      ],
      discount: null,
      vatPercent: 0,
      items: [
        {
          variantId,
          quantity: total / 10,
          unitPrice: 10,
          discount: null,
        },
      ],
    };
  }

  it("NULL limit = unlimited: a customer without a limit takes any due", async () => {
    const customerId = await createCustomer(`NoLimit ${stamp}`, null);
    const summary = await api(
      owner,
      "GET",
      `/api/customers/${customerId}/credit-summary`,
    );
    assert.equal(summary.status, 200);
    const data = payload<{ creditLimit: number | null; outstanding: number; available: number | null }>(summary);
    assert.equal(data.creditLimit, null);
    assert.equal(data.available, null);
    assert.equal(data.outstanding, 0);

    const sale = await api(
      owner,
      "POST",
      "/api/sales",
      dueSalePayload(customerId, 500, 0),
    );
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    assert.equal(Number(sale.body.data.sale.dueAmount), 500);
  });

  it("a limited customer can take a due within the limit and the summary tracks it", async () => {
    const customerId = await createCustomer(`Limit100 ${stamp}`, 100);
    const sale = await api(
      owner,
      "POST",
      "/api/sales",
      dueSalePayload(customerId, 100, 40),
    );
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    assert.equal(Number(sale.body.data.sale.dueAmount), 60);

    const summary = await api(
      owner,
      "GET",
      `/api/customers/${customerId}/credit-summary`,
    );
    const data = payload<{ creditLimit: number | null; outstanding: number; available: number | null }>(summary);
    assert.equal(data.creditLimit, 100);
    assert.equal(data.outstanding, 60);
    assert.equal(data.available, 40);
  });

  it("a due exceeding available credit is rejected with HTTP 409", async () => {
    const customerId = await createCustomer(`Limit50 ${stamp}`, 50);
    // First sale consumes the whole limit as due.
    const first = await api(
      owner,
      "POST",
      "/api/sales",
      dueSalePayload(customerId, 50, 0),
    );
    assert.equal(first.status, 201);
    // Second due would push outstanding past the limit.
    const second = await api(
      owner,
      "POST",
      "/api/sales",
      dueSalePayload(customerId, 10, 0),
    );
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.match(second.body.message, /Credit limit exceeded/);
  });

  it("credit_limit 0 blocks every due sale", async () => {
    const customerId = await createCustomer(`Zero ${stamp}`, 0);
    const sale = await api(
      owner,
      "POST",
      "/api/sales",
      dueSalePayload(customerId, 10, 0),
    );
    assert.equal(sale.status, 409);
    assert.match(sale.body.message, /Credit limit exceeded/);
    // Fully-paid sales stay legal.
    const paid = await api(
      owner,
      "POST",
      "/api/sales",
      dueSalePayload(customerId, 10, 10),
    );
    assert.equal(paid.status, 201);
  });

  it("concurrent due purchases cannot collectively bypass the limit", async () => {
    const customerId = await createCustomer(`Race ${stamp}`, 100);
    // Two parallel sales, each due 60 against a 100 limit — exactly one wins.
    const results = await Promise.allSettled([
      api(owner, "POST", "/api/sales", dueSalePayload(customerId, 60, 0)),
      api(owner, "POST", "/api/sales", dueSalePayload(customerId, 60, 0)),
    ]);
    const statuses = results.map((r) =>
      r.status === "fulfilled" ? r.value.status : 0,
    );
    const created = statuses.filter((s) => s === 201).length;
    const rejected = statuses.filter((s) => s === 409).length;
    assert.equal(created, 1, `statuses=${JSON.stringify(statuses)}`);
    assert.equal(rejected, 1, `statuses=${JSON.stringify(statuses)}`);
  });

  it("due collection restores available credit", async () => {
    const customerId = await createCustomer(`Restore ${stamp}`, 100);
    const sale = await api(
      owner,
      "POST",
      "/api/sales",
      dueSalePayload(customerId, 100, 0),
    );
    assert.equal(sale.status, 201);
    const saleId = sale.body.data.sale.id as number;
    const before = await api(
      owner,
      "GET",
      `/api/customers/${customerId}/credit-summary`,
    );
    assert.equal(payload<{ available: number | null }>(before).available, 0);

    const pay = await api(owner, "POST", "/api/due-management/customer-payment", {
      saleId,
      amount: 100,
      paymentMethod: "cash",
      tendered: 100,
    });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));

    const after = await api(
      owner,
      "GET",
      `/api/customers/${customerId}/credit-summary`,
    );
    const data = payload<{ outstanding: number; available: number | null }>(after);
    assert.equal(data.outstanding, 0);
    assert.equal(data.available, 100);
  });

  it("the limit is editable and the guard follows the new value", async () => {
    const customerId = await createCustomer(`Edit ${stamp}`, 10);
    const blocked = await api(
      owner,
      "POST",
      "/api/sales",
      dueSalePayload(customerId, 20, 0),
    );
    assert.equal(blocked.status, 409);
    const patch = await api(owner, "PATCH", `/api/customers/${customerId}`, {
      name: `Edit ${stamp}`,
      phone: `017${String(Date.now()).slice(-8)}`,
      creditLimit: 200,
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    const nowOk = await api(
      owner,
      "POST",
      "/api/sales",
      dueSalePayload(customerId, 20, 0),
    );
    assert.equal(nowOk.status, 201);
  });
});
