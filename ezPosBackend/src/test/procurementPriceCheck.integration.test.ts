/**
 * Smart Procurement Phase 2 — Quick Price Check (market quotations).
 *
 * Verifies observation CRUD with business scoping, per-unit
 * normalization of packaged quotations, source separation from actual
 * purchases (variant history carries observations alongside purchase
 * events), and that only callers holding `purchases.price_check` can
 * mutate (manager yes, cashier no).
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("procurement price check integration", { skip: !runIntegration }, () => {
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

  const uniqueEmail = (prefix: string) =>
    `pcheck-${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  interface Ctx {
    token: string;
    businessId: number;
  }

  async function registerAndCreateBusiness(prefix: string): Promise<Ctx> {
    const email = uniqueEmail(prefix);
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Price Check Test",
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
    const token = ((await login.json()) as { accessToken: string }).accessToken;
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: `Price Check Biz ${prefix} ${Date.now()}` }),
    });
    assert.equal(biz.status, 201);
    const businessId = ((await biz.json()) as { business: { id: number } }).business.id;
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
    return { token, businessId };
  }

  function apiFor(ctx: Ctx) {
    return async function api(method: string, path: string, body?: unknown) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.token}`,
          "X-Business-Id": String(ctx.businessId),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok && res.status >= 400) {
        const errBody = await res.clone().json().catch(() => null);
        console.error(`API ${method} ${path} -> ${res.status}:`, JSON.stringify(errBody));
      }
      return { status: res.status, json: await res.json() };
    };
  }

  let ctx: Ctx;
  let api: ReturnType<typeof apiFor>;
  let unitId = 0;
  let supplierA = 0;
  let supplierB = 0;
  let variantId = 0;
  let packagedObservationId = 0;
  let plainObservationId = 0;

  async function createVariant(name: string): Promise<number> {
    const prodRes = await api("POST", "/api/product", {
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
          sellingPrice: 200,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: 40,
          quantity: 5,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prodRes.status, 201);
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find(
      (p) => p.name === name,
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    return (detail.json as { variants: { id: number }[] }).variants[0]!.id;
  }

  /** Fully receives a fresh purchase so the variant has one purchase event. */
  async function receivePurchase(price: number, quantity: number, supplierId: number) {
    const create = await api("POST", "/api/purchases", {
      items: [{ variantId, quantity, purchasePrice: price, discount: 0, tax: 0 }],
      supplierId,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
    });
    assert.equal(create.status, 201);
    const items = await api("GET", "/api/purchases/items");
    const rows = items.json as { id: number; variantId: number; purchaseId: number }[];
    const line = rows
      .filter((r) => r.variantId === variantId)
      .sort((a, b) => b.id - a.id)[0]!;
    const receive = await api("POST", "/api/purchases/receive", {
      purchaseId: line.purchaseId,
      items: [
        {
          itemId: line.id,
          trackingType: "none",
          receiveNow: quantity,
          unitCost: price,
          sellingPrice: 200,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(receive.status, 201);
  }

  before(async () => {
    ctx = await registerAndCreateBusiness("a");
    api = apiFor(ctx);
    const unit = await api("POST", "/api/product/unit", {
      unitName: "Kg",
      abbreviation: "Kg",
    });
    unitId = (unit.json as { data: { value: number } }).data.value;
    const supA = await api("POST", "/api/contacts/supplier", {
      supplierName: "Market Shop A",
      phone: "+8801711000011",
      email: null,
      address: null,
    });
    supplierA = (supA.json as { data: { supplierId: number } }).data.supplierId;
    const supB = await api("POST", "/api/contacts/supplier", {
      supplierName: "Market Shop B",
      phone: "+8801711000012",
      email: null,
      address: null,
    });
    supplierB = (supB.json as { data: { supplierId: number } }).data.supplierId;
    variantId = await createVariant("Rice 25 KG");
    // One actual purchase price (100/unit) from supplier A.
    await receivePurchase(100, 10, supplierA);

    // Observation 1: packaged quotation from supplier B — 1500 for 25 units.
    const packaged = await api("POST", "/api/procurement/price-check", {
      variantId,
      supplierId: supplierB,
      quotedPrice: 1500,
      packageQuantity: 25,
      notes: "Sack price at wholesale market",
    });
    assert.equal(packaged.status, 201);
    packagedObservationId = (packaged.json as { data: { id: number } }).data.id;

    // Observation 2: per-unit quotation from supplier A — 110 per Kg.
    const plain = await api("POST", "/api/procurement/price-check", {
      variantId,
      supplierId: supplierA,
      quotedPrice: 110,
      observationDate: new Date().toISOString().slice(0, 10),
    });
    assert.equal(plain.status, 201);
    plainObservationId = (plain.json as { data: { id: number } }).data.id;
  });

  it("normalizes packaged quotations to a per-unit comparison price", async () => {
    const list = await api("GET", "/api/procurement/price-check");
    assert.equal(list.status, 200);
    const data = (list.json as { success: boolean; data: {
      data: {
        id: number;
        productName: string;
        supplierName: string | null;
        quotedPrice: number;
        packageQuantity: number | null;
        unitPrice: number | null;
      }[];
      total: number;
    } }).data;
    assert.equal(data.total, 2);
    const packaged = data.data.find((r) => r.id === packagedObservationId)!;
    assert.equal(packaged.productName, "Rice 25 KG");
    assert.equal(packaged.supplierName, "Market Shop B");
    assert.equal(packaged.quotedPrice, 1500);
    assert.equal(packaged.packageQuantity, 25);
    assert.equal(packaged.unitPrice, 60); // 1500 / 25
    const plain = data.data.find((r) => r.id === plainObservationId)!;
    assert.equal(plain.quotedPrice, 110);
    assert.equal(plain.packageQuantity, null);
    assert.equal(plain.unitPrice, null); // already per unit
  });

  it("keeps quotations out of the actual purchase aggregates but shows them in history", async () => {
    const res = await api(
      "GET",
      `/api/procurement/variants/${variantId}/price-history`,
    );
    assert.equal(res.status, 200);
    const data = (res.json as { data: {
      summary: { latestPrice: number | null; purchaseCount: number };
      suppliers: {
        supplierId: number | null;
        latestPrice: number | null;
        latestQuotation: number | null;
        lastObservationDate: string | null;
      }[];
      records: { total: number };
      observations: {
        data: { id: number; unitPrice: number | null; supplierName: string | null }[];
        total: number;
      };
    } }).data;

    // Actual price history is untouched by the quotations.
    assert.equal(data.summary.latestPrice, 100);
    assert.equal(data.summary.purchaseCount, 1);
    assert.equal(data.records.total, 1);

    // Supplier comparison carries the latest normalized quotation for
    // suppliers with purchase history (B has no purchases — its quotation
    // is visible in the observations list below, not in this table).
    const supA = data.suppliers.find((s) => s.supplierId === supplierA)!;
    assert.equal(supA.latestPrice, 100);
    assert.equal(supA.latestQuotation, 110);
    assert.ok(data.suppliers.every((s) => s.supplierId !== supplierB));

    // Observation list with supplier names is attached for the source-labeled UI.
    assert.equal(data.observations.total, 2);
    assert.equal(data.observations.data.length, 2);
    const supBRow = data.observations.data.find((o) => o.supplierName === "Market Shop B");
    assert.ok(supBRow, "quotation-only supplier visible in observations");
    assert.equal(supBRow.unitPrice, 60);
  });

  it("updates and deletes observations (audit trail written)", async () => {
    const patch = await api(
      "PATCH",
      `/api/procurement/price-check/${packagedObservationId}`,
      { quotedPrice: 1450, notes: "negotiated sack price" },
    );
    assert.equal(patch.status, 200);
    const updated = (patch.json as { data: { quotedPrice: number; unitPrice: number | null; notes: string | null } })
      .data;
    assert.equal(updated.quotedPrice, 1450);
    assert.equal(updated.unitPrice, 58); // 1450 / 25
    assert.equal(updated.notes, "negotiated sack price");

    const del = await api(
      "DELETE",
      `/api/procurement/price-check/${plainObservationId}`,
    );
    assert.equal(del.status, 200);
    const list = await api("GET", "/api/procurement/price-check");
    const data = (list.json as { data: { data: { id: number }[]; total: number } }).data;
    assert.equal(data.total, 1);
    assert.equal(data.data[0]?.id, packagedObservationId);

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const audit = await client.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action IN ('price_check.created','price_check.updated','price_check.deleted')`,
    );
    await client.end();
    assert.ok(audit.rows[0].n >= 3, "create/update/delete audited");
  });

  it("validates input and rejects foreign variants/suppliers", async () => {
    const negative = await api("POST", "/api/procurement/price-check", {
      variantId,
      supplierId: supplierA,
      quotedPrice: -5,
    });
    assert.equal(negative.status, 400);

    const foreignVariant = await api("POST", "/api/procurement/price-check", {
      variantId: 999999,
      supplierId: supplierA,
      quotedPrice: 10,
    });
    assert.equal(foreignVariant.status, 400);

    const foreignSupplier = await api("POST", "/api/procurement/price-check", {
      variantId,
      supplierId: 999999,
      quotedPrice: 10,
    });
    assert.equal(foreignSupplier.status, 400);

    const badDate = await api("POST", "/api/procurement/price-check", {
      variantId,
      supplierId: supplierA,
      quotedPrice: 10,
      observationDate: "not-a-date",
    });
    assert.equal(badDate.status, 400);
  });

  it("isolates tenants — another business cannot see or mutate observations", async () => {
    const other = await registerAndCreateBusiness("b");
    const otherApi = apiFor(other);
    const list = await otherApi("GET", "/api/procurement/price-check");
    assert.equal((list.json as { data: { total: number } }).data.total, 0);
    const patch = await otherApi("PATCH", `/api/procurement/price-check/${packagedObservationId}`, {
      quotedPrice: 1,
    });
    assert.equal(patch.status, 404);
    const del = await otherApi("DELETE", `/api/procurement/price-check/${packagedObservationId}`);
    assert.equal(del.status, 404);
  });

  it("enforces purchases.price_check for mutations (manager yes, cashier no)", async () => {
    const rolesRes = await api("GET", "/api/roles");
    assert.equal(rolesRes.status, 200);
    const rolesBody = rolesRes.json as { data?: { id: number; slug: string }[] };
    const roles = Array.isArray(rolesBody) ? rolesBody : rolesBody.data ?? [];
    const bySlug = new Map(roles.map((r) => [r.slug, r.id]));
    const managerRoleId = bySlug.get("manager")!;
    const accountantRoleId = bySlug.get("accountant")!;

    async function createStaff(label: string, roleIds: number[]): Promise<Ctx> {
      const email = uniqueEmail(label);
      const created = await api("POST", "/api/users", {
        fullName: `Price Check ${label}`,
        email,
        password: "strong-password-123",
        roleIds,
      });
      assert.equal(created.status, 201);
      const userId = (created.json as { data: { userId: number } }).data.userId;
      const patch = await api("PATCH", `/api/users/${userId}`, {
        locationIds: [(await api("GET", "/api/locations")).json.data[0].id],
      });
      assert.equal(patch.status, 200);
      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "strong-password-123" }),
      });
      const token = ((await login.json()) as { accessToken: string }).accessToken;
      return { token, businessId: ctx.businessId };
    }

    const manager = await createStaff("manager", [managerRoleId]);
    const managerApi = apiFor(manager);
    const ok = await managerApi("POST", "/api/procurement/price-check", {
      variantId,
      supplierId: supplierA,
      quotedPrice: 105,
    });
    assert.equal(ok.status, 201);

    // Accountant can read purchase price data (purchases.view) but must
    // not be able to record or edit market observations.
    const accountant = await createStaff("accountant", [accountantRoleId]);
    const accountantApi = apiFor(accountant);
    const forbidden = await accountantApi("POST", "/api/procurement/price-check", {
      variantId,
      supplierId: supplierA,
      quotedPrice: 105,
    });
    assert.equal(forbidden.status, 403);
    const patchForbidden = await accountantApi(
      "PATCH",
      `/api/procurement/price-check/${packagedObservationId}`,
      { quotedPrice: 1 },
    );
    assert.equal(patchForbidden.status, 403);
    // Accountant can still READ the history (purchases.view).
    const read = await accountantApi("GET", "/api/procurement/price-check");
    assert.equal(read.status, 200);
  });
});
