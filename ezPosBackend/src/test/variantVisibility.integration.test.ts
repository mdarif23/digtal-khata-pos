/**
 * Product/variant visibility end-to-end (audit Phase 11).
 *
 * A variant product (Size: Small/Medium/Big) and a plain product are sold,
 * then every identity surface — sold products, product-sales report,
 * dashboard, stock report, receipt — must distinguish the variants and keep
 * per-variant money reconciled. Double-guarded like the other suites: runs
 * ONLY with INTEGRATION_TESTS=1 AND DATABASE_URL pointing at ezpos_test.
 * Plain `npm test` NEVER runs this file.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

interface Res {
  status: number;
  body: any;
}

describe("variant visibility integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  type Ctx = { token: string; businessId: number };
  let owner: Ctx;
  let locationId = 0;
  let smallId = 0;
  let mediumId = 0;
  let bigId = 0;
  let plainVariantId = 0;

  const stamp = Date.now();
  const FOOTBALL = `Football ${stamp}`;
  const PLAIN = `Water Bottle ${stamp}`;

  const SMALL_PRICE = 100;
  const MEDIUM_PRICE = 150;
  const BIG_PRICE = 200;
  const PLAIN_PRICE = 80;

  async function api(
    ctx: Ctx,
    method: "GET" | "POST",
    path: string,
    payload?: unknown,
    locationIdArg?: number,
  ): Promise<Res> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.token}`,
      "X-Business-Id": String(ctx.businessId),
      ...(locationIdArg ? { "X-Location-Id": String(locationIdArg) } : {}),
    };
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(payload ?? {}) } : {}),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

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
       ON CONFLICT (slug) DO NOTHING`,
    );
    await client.end();
    await ensureRbacSeed();

    const app = buildApp();
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Owner + business + location.
    const email = `vv-owner-${stamp}@example.test`;
    await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "VV Owner",
        email,
        password: "strong-password-123",
      }),
    });
    const login = await (await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    })).json();
    owner = { token: login.accessToken, businessId: 0 };
    const biz = await api(
      { token: login.accessToken, businessId: 0 },
      "POST",
      "/api/businesses",
      { name: `VV Biz ${stamp}` },
    );
    owner.businessId = biz.body.business.id;
    const loc = await api(owner, "POST", "/api/locations", {
      name: `VV Main ${stamp}`,
    });
    assert.equal(loc.status, 201);
    locationId = loc.body.data.id;

    const unit = await api(owner, "POST", "/api/product/unit", {
      unitName: `Piece ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = unit.body.data.value;

    // Variant types + options: Size (Small/Medium/Big).
    const sizeType = await api(owner, "POST", "/api/product/variant-type", {
      variantTypeName: `Size ${stamp}`,
    });
    assert.equal(sizeType.status, 201);
    const sizeTypeId = sizeType.body.data?.id ?? sizeType.body.id;
    const sizeOptions = await api(
      owner,
      "POST",
      "/api/product/variant-option",
      {
        variantTypeId: sizeTypeId,
        variantOptionName: ["Small", "Medium", "Big"],
      },
    );
    assert.equal(sizeOptions.status, 201);
    const optionRows = sizeOptions.body.data ?? sizeOptions.body;
    const sizeOptionIds = optionRows.map(
      (o: { id: number; value: string }) => o.id,
    ) as number[];

    const variant = (optionIdx: number, sku: string, price: number) => ({
      sku,
      barcode: null,
      sellingPrice: price,
      alertQuantity: 2,
      isDefault: optionIdx === 0,
      status: "active",
      imageUrl: null,
      imageFile: null,
      batchNumber: `VV-${sku}`,
      purchasePrice: Math.round(price * 0.6),
      quantity: 100,
      expiryDate: null,
      options: [
        {
          typeId: sizeTypeId,
          typeName: "Size",
          optionId: sizeOptionIds[optionIdx],
          value: ["Small", "Medium", "Big"][optionIdx],
        },
      ],
    });

    const football = await api(owner, "POST", "/api/product", {
      name: FOOTBALL,
      categoryId: null,
      brandId: null,
      unitId,
      description: "",
      productType: "physical",
      hasVariants: true,
      trackingType: "none",
      supplierId: null,
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "opening",
      variants: [
        variant(0, `VV-S-${stamp}`, SMALL_PRICE),
        variant(1, `VV-M-${stamp}`, MEDIUM_PRICE),
        variant(2, `VV-B-${stamp}`, BIG_PRICE),
      ],
    });
    assert.equal(football.status, 201, JSON.stringify(football.body));

    const plain = await api(owner, "POST", "/api/product", {
      name: PLAIN,
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
          sku: `VV-PLAIN-${stamp}`,
          barcode: null,
          sellingPrice: PLAIN_PRICE,
          alertQuantity: 2,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `VV-PLAIN-B-${stamp}`,
          purchasePrice: 40,
          quantity: 100,
          expiryDate: null,
          options: [],
        },
      ],
    });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));

    const list = await api(owner, "GET", "/api/products");
    assert.equal(list.status, 200);
    const footballRow = (list.body as any[]).find((p) => p.name === FOOTBALL);
    const plainRow = (list.body as any[]).find((p) => p.name === PLAIN);
    assert.ok(footballRow && plainRow);
    assert.equal(footballRow.variants.length, 3);
    smallId = footballRow.variants.find((v: any) => v.sku === `VV-S-${stamp}`).id;
    mediumId = footballRow.variants.find((v: any) => v.sku === `VV-M-${stamp}`).id;
    bigId = footballRow.variants.find((v: any) => v.sku === `VV-B-${stamp}`).id;
    plainVariantId = plainRow.variants[0].id;

    const register = await api(
      owner,
      "POST",
      "/api/registers",
      { name: `VV Counter ${stamp}` },
      locationId,
    );
    assert.equal(register.status, 201);
    const registerId = register.body.data.id;
    const opened = await api(
      owner,
      "POST",
      `/api/registers/${registerId}/open`,
      { openingCash: 1000 },
      locationId,
    );
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
  });

  after(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  it("sells each variant and the plain product in one sale", async () => {
    // 2×Small(100)=200, 3×Medium(150)=450, 1×Big(200)=200, 4×plain(80)=320
    const sale = await api(
      owner,
      "POST",
      "/api/sales",
      {
        saleDate: new Date().toISOString(),
        customerId: null,
        payments: [{ method: "cash", amount: 1170, tendered: 1170 }],
        discount: null,
        vatPercent: null,
        items: [
          { variantId: smallId, quantity: 2, unitPrice: SMALL_PRICE, discount: null },
          { variantId: mediumId, quantity: 3, unitPrice: MEDIUM_PRICE, discount: null },
          { variantId: bigId, quantity: 1, unitPrice: BIG_PRICE, discount: null },
          { variantId: plainVariantId, quantity: 4, unitPrice: PLAIN_PRICE, discount: null },
        ],
      },
      locationId,
    );
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
  });

  it("sold_products rows identify the variant (name, options, sku)", async () => {
    const res = await api(owner, "GET", "/api/sold_products");
    assert.equal(res.status, 200);
    const rows = res.body as any[];
    const small = rows.find((r) => r.variantId === smallId);
    assert.ok(small, "small variant row missing");
    assert.equal(small.productName, FOOTBALL);
    assert.equal(small.variantName, `${FOOTBALL} (Small)`);
    assert.equal(small.variantOptions, "Small");
    assert.equal(small.sku, `VV-S-${stamp}`);
  });

  it("product sales report groups by variant and reconciles", async () => {
    const res = await api(
      owner,
      "GET",
      "/api/reports/sales/products?startDate=2020-01-01&endDate=2030-12-31&limit=100",
    );
    assert.equal(res.status, 200);
    const envelope = res.body.data as { data: any[] };
    const data = envelope.data;

    const small = data.find((r) => r.variantId === smallId);
    const medium = data.find((r) => r.variantId === mediumId);
    const big = data.find((r) => r.variantId === bigId);
    const plain = data.find((r) => r.variantId === plainVariantId);
    assert.ok(small && medium && big && plain, "each variant needs its own row");

    assert.equal(small.variantName, `${FOOTBALL} (Small)`);
    assert.equal(small.qtySold, 2);
    assert.equal(medium.qtySold, 3);
    assert.equal(big.qtySold, 1);
    assert.equal(Number(plain.qtySold), 4);

    assert.equal(Number(small.grossSales), 2 * SMALL_PRICE);
    assert.equal(Number(medium.grossSales), 3 * MEDIUM_PRICE);
    assert.equal(Number(big.grossSales), BIG_PRICE);
    assert.equal(Number(plain.grossSales), 4 * PLAIN_PRICE);

    // Product total = sum of its variant rows (no merging, no loss).
    const footballGross = [small, medium, big].reduce(
      (sum, r) => sum + Number(r.grossSales),
      0,
    );
    assert.equal(footballGross, 2 * SMALL_PRICE + 3 * MEDIUM_PRICE + BIG_PRICE);
  });

  it("dashboard top items are variant-level", async () => {
    const res = await api(owner, "GET", "/api/dashboard_summary?period=30d");
    assert.equal(res.status, 200);
    const dashboard = (res.body.data ?? res.body) as Record<string, any>;
    const topItems = (dashboard.topItemsByGross ?? []) as any[];
    const small = topItems.find(
      (r) => r.variant_id === smallId || r.variantId === smallId,
    );
    assert.ok(small, "dashboard top items missing the Small variant");
    assert.equal(small.variant_name, `${FOOTBALL} (Small)`);
  });

  it("stock report labels variants and keeps stock separate", async () => {
    const res = await api(
      owner,
      "GET",
      "/api/reports/inventory/stock?startDate=2020-01-01&endDate=2030-12-31&limit=100",
    );
    assert.equal(res.status, 200);
    const envelope = res.body.data as { data: any[] };
    const data = envelope.data;
    const small = data.find((r) => r.variantId === smallId);
    assert.ok(small);
    assert.equal(small.variantName, `${FOOTBALL} (Small)`);
    assert.equal(small.variantOptions, "Small");
    assert.equal(small.currentStock, 98);
    assert.equal(
      data.find((r) => r.variantId === mediumId)?.currentStock,
      97,
    );
  });

  it("receipt carries the option label per line", async () => {
    const salesRes = await api(owner, "GET", "/api/sold_products");
    const rows = salesRes.body as any[];
    const saleId = rows.find((r) => r.variantId === smallId)?.saleId;
    assert.ok(saleId);
    const receipt = await api(owner, "GET", `/api/sales/${saleId}/receipt`);
    assert.equal(receipt.status, 200);
    const items = (receipt.body.items ?? receipt.body.data?.items ?? []) as any[];
    const small = items.find((i) => i.variantId === smallId);
    assert.ok(small);
    assert.equal(small.variantName, "Small");
  });

  it("plain product keeps working exactly as before (no variant suffix)", async () => {
    const res = await api(owner, "GET", "/api/sold_products");
    const rows = res.body as any[];
    const plain = rows.find((r) => r.variantId === plainVariantId);
    assert.ok(plain);
    assert.equal(plain.productName, PLAIN);
    assert.equal(plain.variantName, PLAIN);
    assert.equal(plain.variantOptions, "");
  });
});
