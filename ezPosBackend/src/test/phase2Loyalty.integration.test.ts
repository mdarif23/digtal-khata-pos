/**
 * Phase 2A loyalty engine integration tests (master prompt Feature 5).
 *
 * Covers: earning rules (exclusions, minimum spend, multiplier + bonus),
 * expiry batches + sweep, redemption caps (max per sale), manual
 * adjustments, proportional restoration of REDEEMED points on refunds, and
 * derived tiers with earn multipliers.
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

describe("phase2 loyalty engine", { skip: !runIntegration }, () => {
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
  let variantA = 0; // earns (no exclusions)
  let variantB = 0; // excluded by PRODUCT
  let variantC = 0; // excluded by CATEGORY
  let customerId = 0;

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
        fullName: "L2 Test",
        email: `l2-owner-${stamp}@example.test`,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `l2-owner-${stamp}@example.test`,
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
      body: JSON.stringify({ name: `L2 Biz ${stamp}` }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business: { id: number } };
    owner = {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
      email: `l2-owner-${stamp}@example.test`,
    };

    const loc = await api(owner, "POST", "/api/locations", { name: `L2 Main ${stamp}` });
    assert.equal(loc.status, 201);

    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Pcs ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ data: { value: number } }>(unitRes).data.value;
    const catRes = await api(owner, "POST", "/api/product/category", {
      categoryName: `Excluded Cat ${stamp}`,
      parentCategoryId: null,
      description: "test",
      status: "active",
    });
    assert.equal(catRes.status, 201, JSON.stringify(catRes.body));
    const categoryId = payload<{ data: { value: number } }>(catRes).data.value;

    async function makeProduct(name: string, sku: string, cat: number | null): Promise<number> {
      const product = await api(owner, "POST", "/api/product", {
        name,
        categoryId: cat,
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
            sku,
            barcode: null,
            sellingPrice: 100,
            alertQuantity: 5,
            isDefault: true,
            status: "active",
            imageUrl: null,
            imageFile: null,
            batchNumber: `L2-${sku}`,
            purchasePrice: 40,
            quantity: 500,
            expiryDate: null,
          },
        ],
      });
      assert.equal(product.status, 201, JSON.stringify(product.body));
      const list = await api(owner, "GET", "/api/products");
      const created = (
        list.body as { name: string; variants: { id: number }[] }[]
      ).find((p) => p.name === name);
      assert.ok(created);
      return created.variants[0]!.id;
    }

    variantA = await makeProduct(`L2 Earn ${stamp}`, `L2A-${stamp}`, null);
    variantB = await makeProduct(`L2 ExclProd ${stamp}`, `L2B-${stamp}`, null);
    variantC = await makeProduct(`L2 ExclCat ${stamp}`, `L2C-${stamp}`, categoryId);

    const cust = await api(owner, "POST", "/api/customers", {
      name: `L2 Customer ${stamp}`,
      phone: `017${String(stamp).slice(-8)}`,
      email: `l2-${stamp}@example.test`,
      address: "",
    });
    assert.equal(cust.status, 201, JSON.stringify(cust.body));
    const custBody = cust.body as { data?: { id?: number }; id?: number };
    customerId = (custBody.data?.id ?? custBody.id)!;

    // Program with fixed 1-day expiry + a 100-point per-sale cap.
    const put = await api(owner, "PUT", "/api/loyalty/program", {
      earnRate: 0.01,
      redeemValue: 1,
      isActive: true,
      expiryMode: "fixed",
      expiryDays: 1,
      minRedemptionPoints: 0,
      maxRedemptionPointsPerSale: 100,
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
  });

  async function saleWith(
    items: { variantId: number; quantity: number; unitPrice: number; discount: null }[],
    payments: Record<string, unknown>[],
  ): Promise<{ status: number; body: any }> {
    return api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments,
      discount: null,
      vatPercent: 0,
      items,
    });
  }

  async function balance(): Promise<number> {
    const res = await api(owner, "GET", `/api/customers/${customerId}/loyalty`);
    assert.equal(res.status, 200);
    return payload<{ data: { balance: number } }>(res).data.balance;
  }

  async function productIdOf(variantId: number): Promise<number> {
    const rows = await dbQuery(
      "SELECT product_id FROM product_variants WHERE id = $1",
      [variantId],
    );
    return rows[0].product_id as number;
  }

  async function categoryIdOf(variantId: number): Promise<number> {
    const rows = await dbQuery(
      `SELECT p.category_id FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE pv.id = $1`,
      [variantId],
    );
    return rows[0].category_id as number;
  }

  it("POS config endpoint exposes the redemption caps without manage permission", async () => {
    const cfg = await api(owner, "GET", "/api/loyalty/config");
    assert.equal(cfg.status, 200);
    const data = payload<{
      data: { maxRedemptionPointsPerSale: number; redeemValue: number } | null;
    }>(cfg).data;
    assert.ok(data);
    assert.equal(data!.maxRedemptionPointsPerSale, 100);
    assert.equal(data!.redeemValue, 1);
  });

  it("excluded products and categories do not earn; multiplier and bonus apply", async () => {
    const put = await api(owner, "PUT", "/api/loyalty/earn-rule", {
      isActive: true,
      minTransactionAmount: 50,
      excludedCategoryIds: [],
      excludedProductIds: [await productIdOf(variantB)],
      bonusPoints: 5,
      multiplier: 2,
      startsAt: null,
      endsAt: null,
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const before = await balance();
    // 100 earning product → 100×0.01×2 = 2 + 5 bonus = 7.
    const sale = await saleWith(
      [{ variantId: variantA, quantity: 1, unitPrice: 100, discount: null }],
      [{ method: "cash", amount: 100, tendered: 100 }],
    );
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    assert.equal(await balance(), before + 7);

    // Excluded-only cart: eligible base 0 < 50 minimum → nothing earns.
    const before2 = await balance();
    const sale2 = await saleWith(
      [{ variantId: variantB, quantity: 1, unitPrice: 100, discount: null }],
      [{ method: "cash", amount: 100, tendered: 100 }],
    );
    assert.equal(sale2.status, 201);
    assert.equal(await balance(), before2);

    // Mixed cart: only the earning line earns.
    const before3 = await balance();
    const sale3 = await saleWith(
      [
        { variantId: variantA, quantity: 1, unitPrice: 100, discount: null },
        { variantId: variantB, quantity: 1, unitPrice: 100, discount: null },
      ],
      [{ method: "cash", amount: 200, tendered: 200 }],
    );
    assert.equal(sale3.status, 201);
    assert.equal(await balance(), before3 + 7);

    // Category exclusion via rule update.
    await api(owner, "PUT", "/api/loyalty/earn-rule", {
      isActive: true,
      minTransactionAmount: 0,
      excludedCategoryIds: [await categoryIdOf(variantC)],
      excludedProductIds: [],
      bonusPoints: 0,
      multiplier: 1,
      startsAt: null,
      endsAt: null,
    });
    const before4 = await balance();
    const sale4 = await saleWith(
      [{ variantId: variantC, quantity: 1, unitPrice: 100, discount: null }],
      [{ method: "cash", amount: 100, tendered: 100 }],
    );
    assert.equal(sale4.status, 201);
    assert.equal(await balance(), before4);
  });

  it("enforces the per-sale redemption cap", async () => {
    // Ensure enough points: adjust if needed.
    let current = await balance();
    if (current < 150) {
      const adj = await api(owner, "POST", `/api/customers/${customerId}/loyalty/adjust`, {
        points: 200,
        reason: "Test seeding for cap checks",
      });
      assert.equal(adj.status, 200);
      current = await balance();
    }
    // 200 sale: 150 in points (over the 100 cap) + 50 cash — payment sums
    // correctly, so the CAP is what rejects it.
    const capped = await saleWith(
      [{ variantId: variantA, quantity: 2, unitPrice: 100, discount: null }],
      [
        { method: "loyalty_points", amount: 150 },
        { method: "cash", amount: 50, tendered: 50 },
      ],
    );
    assert.equal(capped.status, 409, JSON.stringify(capped.body));
    assert.match(String(capped.body?.message ?? ""), /capped/i);

    const ok = await saleWith(
      [{ variantId: variantA, quantity: 1, unitPrice: 100, discount: null }],
      [
        { method: "loyalty_points", amount: 100 },
        { method: "cash", amount: 0, tendered: 0 },
      ],
    );
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });

  it("manual adjustments require a reason and update the balance", async () => {
    const before = await balance();
    const bad = await api(owner, "POST", `/api/customers/${customerId}/loyalty/adjust`, {
      points: 10,
      reason: "x",
    });
    assert.equal(bad.status, 400);
    const ok = await api(owner, "POST", `/api/customers/${customerId}/loyalty/adjust`, {
      points: 10,
      reason: "Goodwill compensation",
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(await balance(), before + 10);

    const audit = await dbQuery(
      `SELECT id FROM audit_log WHERE business_id = $1 AND action = 'loyalty.adjusted' LIMIT 1`,
      [owner.businessId],
    );
    assert.ok(audit.length > 0);
  });

  it("restores redeemed points proportionally when a sale is refunded", async () => {
    await api(owner, "PUT", "/api/loyalty/earn-rule", {
      isActive: false,
      minTransactionAmount: 0,
      excludedCategoryIds: [],
      excludedProductIds: [],
      bonusPoints: 0,
      multiplier: 1,
      startsAt: null,
      endsAt: null,
    });
    const before = await balance();
    // Sale 200: redeem 100, cash 100 → earn 1 on the cash portion.
    const sale = await saleWith(
      [{ variantId: variantA, quantity: 2, unitPrice: 100, discount: null }],
      [
        { method: "loyalty_points", amount: 100 },
        { method: "cash", amount: 100, tendered: 100 },
      ],
    );
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const afterSale = await balance();

    // Full refund → −1 clawback (earned on cash) + 100 restored (redeemed).
    const refund = await api(
      owner,
      "POST",
      `/api/sold_products/refunds_all/${
        payload<{ data: { sale: { id: number } } }>(sale).data.sale.id
      }`,
      { reason: "customer_request", disposition: "restock" },
    );
    assert.equal(refund.status, 200, JSON.stringify(refund.body));
    const afterRefund = await balance();
    // clawback −2 (refundTotal × earnRate on the FULL sale), restore +100
    // (all redeemed points returned proportionally to the full refund).
    assert.equal(afterRefund, afterSale - 2 + 100);
    assert.equal(afterRefund, before - 1); // net: 100 redeemed came back
  });

  it("expires due batches in the sweep and writes expiry ledger rows", async () => {
    await dbQuery(
      `UPDATE loyalty_points_batches SET expires_at = now() - interval '1 hour' WHERE business_id = $1 AND customer_id = $2 AND points_remaining > 0`,
      [owner.businessId, customerId],
    );
    // Normalize a possible negative clawback balance (clawbacks may go
    // negative by design) so the sweep assertion is meaningful.
    const preSweep = await balance();
    if (preSweep < 0) {
      const adj = await api(owner, "POST", `/api/customers/${customerId}/loyalty/adjust`, {
        points: Math.ceil(-preSweep) + 20,
        reason: "Normalize balance before expiry sweep",
      });
      assert.equal(adj.status, 200);
    }
    const before = await balance();
    assert.ok(before > 0, `balance before sweep must be positive, got ${before}`);

    const { runLoyaltyExpirySweep } = await import("../services/loyalty.js");
    const sweep = await runLoyaltyExpirySweep(owner.businessId);
    assert.ok(sweep.pointsExpired >= before, JSON.stringify(sweep));
    // Balance after = before − expired batch points; clawback negatives may
    // keep it slightly below zero — assert it dropped by the expired amount.
    const afterSweep = await balance();
    assert.equal(afterSweep, before - sweep.pointsExpired);

    const ledger = await dbQuery(
      `SELECT points, entry_type FROM loyalty_ledger WHERE business_id = $1 AND customer_id = $2 AND source_type = 'expiry' ORDER BY id DESC LIMIT 1`,
      [owner.businessId, customerId],
    );
    assert.ok(ledger.length > 0);
    assert.ok(Number(ledger[0].points) < 0);
    assert.equal(ledger[0].entry_type, "expired");

    const again = await runLoyaltyExpirySweep(owner.businessId);
    assert.equal(again.pointsExpired, 0);
  });

  it("derives tiers from spend and applies the tier earn multiplier", async () => {
    await api(owner, "PUT", "/api/loyalty/program", {
      earnRate: 0.01,
      redeemValue: 1,
      isActive: true,
      expiryMode: "none",
    });
    const tiers = await api(owner, "POST", "/api/loyalty/tiers", {
      name: "Gold",
      minSpend: 500,
      qualificationMonths: null,
      earnMultiplier: 2,
      rank: 10,
      isActive: true,
    });
    assert.equal(tiers.status, 201, JSON.stringify(tiers.body));

    const state = await dbQuery(
      `SELECT lifetime_spend FROM customer_loyalty_state WHERE business_id = $1 AND customer_id = $2`,
      [owner.businessId, customerId],
    );
    assert.ok(state.length > 0, "loyalty state row must exist");
    assert.ok(
      Number(state[0].lifetime_spend) >= 500,
      `lifetime spend ${state[0].lifetime_spend}`,
    );

    // Normalize any negative clawback residue so the earn math is clean.
    const pre = await balance();
    if (pre < 0) {
      const adj = await api(owner, "POST", `/api/customers/${customerId}/loyalty/adjust`, {
        points: Math.ceil(-pre) + 10,
        reason: "Normalize balance before tier earn check",
      });
      assert.equal(adj.status, 200);
    }
    const before = await balance();
    const sale = await saleWith(
      [{ variantId: variantA, quantity: 1, unitPrice: 100, discount: null }],
      [{ method: "cash", amount: 100, tendered: 100 }],
    );
    assert.equal(sale.status, 201);
    assert.equal(await balance(), before + 2); // 100 × 0.01 × 2 (Gold)

    const overview = await api(owner, "GET", `/api/customers/${customerId}/loyalty`);
    const data = payload<{
      data: { tier: { name: string } | null; lifetimeEarned: number };
    }>(overview).data;
    assert.equal(data.tier?.name, "Gold");
  });
});
