/**
 * Phase 2B quotation integration tests (master prompt Feature 7).
 *
 * Covers: creation with snapshot totals (no stock effect), status
 * transitions with invalid-transition guards, transactional conversion
 * into a sale (stock deducted exactly once, single-shot conversion), and
 * the expiry sweep.
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

describe("phase2 quotations", { skip: !runIntegration }, () => {
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
  let variantId = 0;
  let customerId: number | null = null;

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
        fullName: "Q2 Test",
        email: `q2-owner-${stamp}@example.test`,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `q2-owner-${stamp}@example.test`,
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
      body: JSON.stringify({ name: `Q2 Biz ${stamp}` }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business: { id: number } };
    owner = {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
      email: `q2-owner-${stamp}@example.test`,
    };

    await api(owner, "POST", "/api/locations", { name: `Q2 Main ${stamp}` });
    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Pcs ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ data: { value: number } }>(unitRes).data.value;
    const product = await api(owner, "POST", "/api/product", {
      name: `Q2 Chair ${stamp}`,
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
          sku: `Q2-${stamp}`,
          barcode: null,
          sellingPrice: 1000,
          alertQuantity: 5,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `Q2B-${stamp}`,
          purchasePrice: 400,
          quantity: 50,
          expiryDate: null,
        },
      ],
    });
    assert.equal(product.status, 201);
    const list = await api(owner, "GET", "/api/products");
    const created = (
      list.body as { name: string; variants: { id: number }[] }[]
    ).find((p) => p.name === `Q2 Chair ${stamp}`);
    assert.ok(created);
    variantId = created.variants[0]!.id;

    const cust = await api(owner, "POST", "/api/customers", {
      name: `Q2 Customer ${stamp}`,
      phone: `018${String(stamp).slice(-8)}`,
      email: null,
      address: "",
    });
    assert.equal(cust.status, 201);
    const custBody = cust.body as { data?: { id?: number }; id?: number };
    customerId = (custBody.data?.id ?? custBody.id)!;
  });

  function quotationPayload(overrides: Record<string, unknown> = {}) {
    return {
      customerId,
      items: [
        {
          variantId,
          quantity: 2,
          unitPrice: 1000,
          discount: 100,
        },
      ],
      vatPercent: 5,
      notes: "Preferred customer",
      terms: "50% advance",
      validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      ...overrides,
    };
  }

  it("creates a quotation with snapshot totals and no stock effect", async () => {
    const stockBefore = await dbQuery(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1`,
      [variantId],
    );
    const res = await api(owner, "POST", "/api/quotations", quotationPayload());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { id, quoteNumber } = payload<{ data: { id: number; quoteNumber: string } }>(res).data;
    assert.match(quoteNumber, /^QT-\d{4}-\d{6}$/);

    const detail = await api(owner, "GET", `/api/quotations/${id}`);
    const data = payload<{ data: Record<string, unknown> }>(detail).data;
    // subtotal 2000, discount 100, net 1900, VAT 5% = 95, total 1995.
    assert.equal(Number(data.subtotal), 2000);
    assert.equal(Number(data.discountTotal), 100);
    assert.equal(Number(data.vatTotal), 95);
    assert.equal(Number(data.grandTotal), 1995);

    const stockAfter = await dbQuery(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1`,
      [variantId],
    );
    assert.equal(
      Number(stockAfter[0].quantity),
      Number(stockBefore[0].quantity),
      "quotation creation must not touch stock",
    );
  });

  it("guards status transitions", async () => {
    const created = await api(owner, "POST", "/api/quotations", quotationPayload());
    const id = payload<{ data: { id: number } }>(created).data.id;

    // draft → accepted is allowed by design (walk-in accept); but
    // rejected → sent must fail.
    await api(owner, "POST", `/api/quotations/${id}/status`, { status: "rejected" });
    const bad = await api(owner, "POST", `/api/quotations/${id}/status`, {
      status: "sent",
    });
    assert.equal(bad.status, 409, JSON.stringify(bad.body));

    // Draft editing is blocked after leaving draft.
    const edit = await api(owner, "PATCH", `/api/quotations/${id}`, quotationPayload());
    assert.equal(edit.status, 409);
  });

  it("converts an accepted quotation into exactly one sale", async () => {
    const stockBefore = await dbQuery(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1`,
      [variantId],
    );
    const created = await api(owner, "POST", "/api/quotations", quotationPayload());
    const id = payload<{ data: { id: number } }>(created).data.id;
    await api(owner, "POST", `/api/quotations/${id}/status`, { status: "accepted" });

    const convert = await api(owner, "POST", `/api/quotations/${id}/convert`, {
      payments: [{ method: "cash", amount: 1995, tendered: 2000 }],
    });
    assert.equal(convert.status, 200, JSON.stringify(convert.body));
    const { saleId, quoteNumber } = payload<{ data: { saleId: number; quoteNumber: string } }>(convert).data;
    assert.ok(saleId > 0);
    assert.match(quoteNumber, /^QT-/);

    const stockAfter = await dbQuery(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1`,
      [variantId],
    );
    assert.equal(
      Number(stockBefore[0].quantity) - Number(stockAfter[0].quantity),
      2,
      "conversion must deduct stock exactly once",
    );

    // The quotation is converted and linked; a second conversion is refused.
    const detail = await api(owner, "GET", `/api/quotations/${id}`);
    const data = payload<{ data: { status: string; convertedSaleId: number | null } }>(detail).data;
    assert.equal(data.status, "converted");
    assert.equal(data.convertedSaleId, saleId);

    const again = await api(owner, "POST", `/api/quotations/${id}/convert`, {
      payments: [{ method: "cash", amount: 1995 }],
    });
    assert.equal(again.status, 409);
  });

  it("expires draft/sent quotations past their valid_until in the sweep", async () => {
    const stale = await api(
      owner,
      "POST",
      "/api/quotations",
      quotationPayload({
        validUntil: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      }),
    );
    assert.equal(stale.status, 201);
    const staleId = payload<{ data: { id: number } }>(stale).data.id;

    const { runQuotationExpirySweep } = await import(
      "../modules/quotations/quotations.service.js"
    );
    const sweep = await runQuotationExpirySweep();
    assert.ok(sweep.expired >= 1, JSON.stringify(sweep));

    const detail = await api(owner, "GET", `/api/quotations/${staleId}`);
    assert.equal(
      payload<{ data: { status: string } }>(detail).data.status,
      "expired",
    );

    // Expired quotations cannot convert.
    const convert = await api(owner, "POST", `/api/quotations/${staleId}/convert`, {
      payments: [{ method: "cash", amount: 1995 }],
    });
    assert.equal(convert.status, 409);
  });
});
