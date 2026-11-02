/**
 * Tax engine integration tests (Module 4, Phase 1).
 *
 * Covers: exclusive VAT, inclusive extraction, exemptions, the legacy
 * vatPercent fallback, effective-date scoping, historical snapshot
 * preservation across rate changes, receipt breakdown, and
 * sales.vat = Σ line tax consistency.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("tax engine integration", { skip: !runIntegration }, () => {
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

    // New permission keys (taxes.view / taxes.manage) must exist before any
    // business is created — buildApp does not run the startup seed.
    const { ensureRbacSeed } = await import("../rbac/seed.js");
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
    `tax-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let unitId = 0;

  async function api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      console.error(
        `API ${method} ${path} -> ${res.status}:`,
        JSON.stringify(await res.clone().json().catch(() => null)),
      );
    }
    return { status: res.status, json: await res.json() };
  }

  async function registerAndCreateBusiness(): Promise<void> {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Tax Test", email, password: "strong-password-123" }),
    });
    if (reg.status !== 201) {
      console.error("register ->", reg.status, JSON.stringify(await reg.json()).slice(0, 300));
    }
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    const loginBody = (await login.json()) as { accessToken: string };
    token = loginBody.accessToken;
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: `Tax Biz ${Date.now()}` }),
    });
    if (biz.status !== 201) {
      console.error("businesses ->", biz.status, JSON.stringify(await biz.json()).slice(0, 300), "token:", token.slice(0, 20));
    }
    assert.equal(biz.status, 201);
    businessId = ((await biz.json()) as { business: { id: number } }).business.id;
    const loc = await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
      },
      body: JSON.stringify({ name: "Main Store" }),
    });
    assert.equal(loc.status, 201);
    const unit = await api("POST", "/api/product/unit", {
      unitName: "Piece",
      abbreviation: "Pcs",
    });
    assert.equal(unit.status, 201);
    unitId = unit.json.data.value;
  }

  async function createProduct(
    name: string,
    sellingPrice: number,
  ): Promise<number> {
    const res = await api("POST", "/api/product", {
      name,
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
          sku: "",
          barcode: null,
          sellingPrice,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: Math.round(sellingPrice / 2),
          quantity: 10,
          expiryDate: null,
        },
      ],
    });
    assert.equal(res.status, 201);
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find(
      (p) => p.name === name,
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    return (detail.json as { variants: { id: number }[] }).variants[0]!.id;
  }

  /**
   * Full-credit sale; returns {saleId, receipt}. `expectedTotal` is the
   * final total the backend must compute (price + exclusive tax, or the
   * price itself for inclusive/exempt lines) — payments must match it.
   */
  async function createDueSale(
    variantId: number,
    price: number,
    expectedTotal: number,
    vatPercent: number | null = null,
  ) {
    const custRes = await api("POST", "/api/customers", {
      name: `Tax Cust ${Date.now()}`,
      phone: "1711000000",
    });
    assert.equal(custRes.status, 201);
    const customerId = custRes.json.id;
    const res = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "due", amount: expectedTotal }],
      discount: null,
      vatPercent,
      items: [{ variantId, quantity: 1, unitPrice: price, discount: null }],
    });
    assert.equal(res.status, 201);
    const body = res.json as { data: { sale: { id: number } } };
    const receiptRes = await api("GET", `/api/sales/${body.data.sale.id}/receipt`);
    assert.equal(receiptRes.status, 200);
    return { saleId: body.data.sale.id, receipt: receiptRes.json };
  }

  let vatExclusiveVariant = 0;
  let vatInclusiveVariant = 0;
  let exemptVariant = 0;
  let exclusiveRateId = 0;
  let inclusiveRateId = 0;

  it("sets up the business, tax rates, and product assignments", async () => {
    await registerAndCreateBusiness();

    const exRes = await api("POST", "/api/tax-rates", {
      name: "VAT 15%",
      rate: 15,
      isInclusive: false,
    });
    assert.equal(exRes.status, 201);
    exclusiveRateId = exRes.json.data.id;

    const incRes = await api("POST", "/api/tax-rates", {
      name: "VAT 15% incl",
      rate: 15,
      isInclusive: true,
    });
    assert.equal(incRes.status, 201);
    inclusiveRateId = incRes.json.data.id;

    assert.equal(exRes.json.data.rate, 15);

    vatExclusiveVariant = await createProduct("Taxed Exclusive", 100);
    vatInclusiveVariant = await createProduct("Taxed Inclusive", 115);
    exemptVariant = await createProduct("Exempt Good", 100);
  });

  it("assigns tax rates to products (replace-set semantics)", async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const variantRows = await client.query(
      `SELECT id, product_id FROM product_variants WHERE id = ANY($1)`,
      [[vatExclusiveVariant, vatInclusiveVariant]],
    );
    await client.end();

    for (const row of variantRows.rows as { id: number; product_id: number }[]) {
      const rateId =
        row.id === vatExclusiveVariant ? exclusiveRateId : inclusiveRateId;
      const res = await api("PUT", `/api/products/${row.product_id}/tax-rates`, {
        taxRateIds: [rateId],
      });
      assert.equal(res.status, 200);
    }

    // Read-back
    const readRes = await api(
      "GET",
      `/api/products/${(variantRows.rows as { id: number; product_id: number }[]).find((r) => r.id === vatExclusiveVariant)!.product_id}/tax-rates`,
    );
    assert.equal(readRes.status, 200);
    assert.equal(readRes.json.data.length, 1);
    assert.equal(readRes.json.data[0].rate, 15);
  });

  it("applies exclusive VAT: 100 + 15 = 115 with a per-line snapshot", async () => {
    const { saleId, receipt } = await createDueSale(vatExclusiveVariant, 100, 115);
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const sale = await client.query(
      `SELECT subtotal, vat, final_total, due_amount FROM sales WHERE id = $1`,
      [saleId],
    );
    const item = await client.query(
      `SELECT tax_amount, tax_detail FROM sale_items WHERE sale_id = $1`,
      [saleId],
    );
    await client.end();

    assert.equal(Number(sale.rows[0].vat), 15);
    assert.equal(Number(sale.rows[0].final_total), 115);
    assert.equal(Number(sale.rows[0].due_amount), 115);
    assert.equal(Number(item.rows[0].tax_amount), 15);
    const detail = item.rows[0].tax_detail as {
      taxRateId: number;
      name: string;
      rate: number;
      isInclusive: boolean;
      amount: number;
    }[];
    assert.equal(detail.length, 1);
    const firstRule = detail[0]!;
    assert.equal(firstRule.taxRateId, exclusiveRateId);
    assert.equal(firstRule.rate, 15);
    assert.equal(firstRule.amount, 15);

    // Receipt carries the breakdown.
    const receiptItem = receipt.items[0];
    assert.equal(Number(receiptItem.taxAmount), 15);
  });

  it("applies inclusive VAT: extracted from the price, total unchanged", async () => {
    const { saleId } = await createDueSale(vatInclusiveVariant, 115, 115);
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const sale = await client.query(
      `SELECT vat, final_total, due_amount FROM sales WHERE id = $1`,
      [saleId],
    );
    const item = await client.query(
      `SELECT tax_amount FROM sale_items WHERE sale_id = $1`,
      [saleId],
    );
    await client.end();

    assert.equal(Number(sale.rows[0].vat), 15); // 115 − 115/1.15
    assert.equal(Number(sale.rows[0].final_total), 115); // inclusive: unchanged
    assert.equal(Number(sale.rows[0].due_amount), 115);
    assert.equal(Number(item.rows[0].tax_amount), 15);
  });

  it("treats unassigned products as exempt in rules mode (no legacy VAT applied)", async () => {
    // Same cart carries an assigned and an unassigned product: rules mode
    // must not ALSO apply the legacy vatPercent to the exempt line.
    const custRes = await api("POST", "/api/customers", {
      name: `Mixed Cust ${Date.now()}`,
      phone: "1711000001",
    });
    const customerId = custRes.json.id;
    const res = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "due", amount: 215 }],
      discount: null,
      vatPercent: 10, // legacy rate present — must be ignored in rules mode
      items: [
        { variantId: vatExclusiveVariant, quantity: 1, unitPrice: 100, discount: null },
        { variantId: exemptVariant, quantity: 1, unitPrice: 100, discount: null },
      ],
    });
    assert.equal(res.status, 201);
    const saleId = (res.json as { data: { sale: { id: number } } }).data.sale.id;

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const sale = await client.query(
      `SELECT vat, final_total FROM sales WHERE id = $1`,
      [saleId],
    );
    const items = await client.query(
      `SELECT variant_id, tax_amount FROM sale_items WHERE sale_id = $1 ORDER BY variant_id`,
      [saleId],
    );
    await client.end();

    assert.equal(Number(sale.rows[0].vat), 15); // only the assigned line
    assert.equal(Number(sale.rows[0].final_total), 215); // 200 + 15
    const exemptRow = items.rows.find(
      (r: { variant_id: number }) => r.variant_id === exemptVariant,
    )!;
    assert.equal(Number(exemptRow.tax_amount), 0);
  });

  it("falls back to legacy vatPercent when NO product has assignments", async () => {
    const sale = await createDueSale(exemptVariant, 100, 110, 10);
    assert.equal(Number(sale.receipt.vat), 10);
    assert.equal(Number(sale.receipt.finalTotal), 110);
  });

  it("preserves historical tax snapshots when the rate changes", async () => {
    // Sale at 15%...
    const first = await createDueSale(vatExclusiveVariant, 100, 115);
    assert.equal(Number(first.receipt.vat), 15);

    // ...rate changed to 20%...
    const upd = await api("PATCH", `/api/tax-rates/${exclusiveRateId}`, {
      rate: 20,
      name: "VAT 20%",
    });
    assert.equal(upd.status, 200);

    // ...new sale uses 20%, old sale snapshot untouched.
    const second = await createDueSale(vatExclusiveVariant, 100, 120);
    assert.equal(Number(second.receipt.vat), 20);
    assert.equal(Number(first.receipt.vat), 15); // history intact

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const items = await client.query(
      `SELECT si.tax_detail FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       WHERE s.id = ANY($1) AND si.variant_id = $2
       ORDER BY s.id`,
      [[first.saleId, second.saleId], vatExclusiveVariant],
    );
    await client.end();
    const firstDetail = (
      items.rows[0].tax_detail as { rate: number; name: string }[]
    )[0]!;
    const secondDetail = (
      items.rows[1].tax_detail as { rate: number; name: string }[]
    )[0]!;
    assert.equal(firstDetail.rate, 15);
    assert.equal(firstDetail.name, "VAT 15%");
    assert.equal(secondDetail.rate, 20);
    assert.equal(secondDetail.name, "VAT 20%");
  });

  it("honors effective dates: a future rate does not apply today", async () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    const res = await api("POST", "/api/tax-rates", {
      name: "Future VAT 30%",
      rate: 30,
      isInclusive: false,
      validFrom: future.toISOString().slice(0, 10),
    });
    assert.equal(res.status, 201);
    const futureRateId = res.json.data.id;

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const prodRes = await client.query(
      `SELECT product_id FROM product_variants WHERE id = $1`,
      [vatExclusiveVariant],
    );
    await client.end();
    const assign = await api("PUT", `/api/products/${prodRes.rows[0].product_id}/tax-rates`, {
      taxRateIds: [futureRateId],
    });
    assert.equal(assign.status, 200);

    const { saleId } = await createDueSale(vatExclusiveVariant, 100, 100);
    const { default: pg2 } = await import("pg");
    const client2 = new pg2.Client({ connectionString: process.env.DATABASE_URL });
    await client2.connect();
    const sale = await client2.query(
      `SELECT vat, final_total FROM sales WHERE id = $1`,
      [saleId],
    );
    await client2.end();
    assert.equal(Number(sale.rows[0].vat), 0); // rate not yet effective
    assert.equal(Number(sale.rows[0].final_total), 100);
  });

  it("keeps sales.vat equal to the sum of line tax amounts", async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    // Rules-mode sales only: legacy vatPercent sales carry no per-line
    // snapshot by design.
    const mismatch = await client.query(
      `SELECT s.id FROM sales s
       JOIN sale_items si ON si.sale_id = s.id AND si.business_id = s.business_id
       WHERE s.business_id = $1
       GROUP BY s.id, s.vat
       HAVING BOOL_OR(si.tax_detail <> '[]'::jsonb)
          AND ABS(s.vat - SUM(si.tax_amount)) > 0.01`,
      [businessId],
    );
    await client.end();
    assert.equal(mismatch.rows.length, 0);
  });

  it("deactivates a rate and the product becomes exempt; hard delete is refused", async () => {
    const del = await api("DELETE", `/api/tax-rates/${inclusiveRateId}`);
    assert.equal(del.status, 200);
    assert.equal(del.json.data.isActive, false);

    // Inclusive product now has no active assignment → exempt in rules mode.
    const { saleId } = await createDueSale(vatInclusiveVariant, 115, 115);
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const sale = await client.query(`SELECT vat, final_total FROM sales WHERE id = $1`, [saleId]);
    await client.end();
    assert.equal(Number(sale.rows[0].vat), 0);
    assert.equal(Number(sale.rows[0].final_total), 115);
  });
});
