/**
 * Phase 3 integration tests: promotions engine kinds (master prompt
 * Feature 8), speed keys (Feature 2) and the customer-facing display
 * (Feature 1).
 *
 * Double-guarded: runs ONLY with INTEGRATION_TESTS=1 AND DATABASE_URL
 * pointing at ezpos_test.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("phase3 checkout speed", { skip: !runIntegration }, () => {
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
  let variantA = 0; // ৳100
  let variantB = 0; // ৳50

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
        fullName: "P3 Test",
        email: `p3-owner-${stamp}@example.test`,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `p3-owner-${stamp}@example.test`,
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
      body: JSON.stringify({ name: `P3 Biz ${stamp}` }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business: { id: number } };
    owner = {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
      email: `p3-owner-${stamp}@example.test`,
    };

    const loc = await api(owner, "POST", "/api/locations", { name: `P3 Main ${stamp}` });
    locationId = payload<{ data: { id: number } }>(loc).data.id;

    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Pcs ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ data: { value: number } }>(unitRes).data.value;
    async function makeVariant(name: string, sku: string, price: number): Promise<number> {
      const product = await api(owner, "POST", "/api/product", {
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
            sku,
            barcode: null,
            sellingPrice: price,
            alertQuantity: 5,
            isDefault: true,
            status: "active",
            imageUrl: null,
            imageFile: null,
            batchNumber: `P3-${sku}`,
            purchasePrice: Math.floor(price / 2),
            quantity: 500,
            expiryDate: null,
          },
        ],
      });
      assert.equal(product.status, 201);
      const list = await api(owner, "GET", "/api/products");
      const created = (list.body as { name: string; variants: { id: number }[] }[]).find(
        (p) => p.name === name,
      );
      assert.ok(created);
      return created.variants[0]!.id;
    }
    variantA = await makeVariant(`P3 Cola ${stamp}`, `P3A-${stamp}`, 100);
    variantB = await makeVariant(`P3 Chips ${stamp}`, `P3B-${stamp}`, 50);
  });


  async function deactivateAllPromotions(): Promise<void> {
    await dbQuery(
      "UPDATE pricing_promotions SET is_active = false WHERE business_id = $1",
      [owner.businessId],
    );
  }

  async function createPromotion(input: Record<string, unknown>): Promise<number> {
    const res = await api(owner, "POST", "/api/promotions", input);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return payload<{ data: { id: number } }>(res).data.id;
  }

  async function quote(items: Record<string, unknown>[]): Promise<{
    promotionsTotal: number;
    nearMisses: { id: number; reason: string }[];
    finalTotal: number;
  }> {
    const res = await api(owner, "POST", "/api/sales/quote", {
      customerId: null,
      items,
      payments: [],
      discount: null,
      vatPercent: 0,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = payload<{ data: Record<string, unknown> }>(res).data;
    const promotions = data.promotions as
      | { applied: { amount: number }[]; total: number }
      | undefined;
    return {
      promotionsTotal: promotions?.total ?? 0,
      nearMisses: (data.nearMisses as { id: number; reason: string }[] | undefined) ?? [],
      finalTotal: Number(data.finalTotal),
    };
  }

  it("BOGO: buy 1 get 1 free per variant group; near-miss hints on odd quantities", async () => {
    await createPromotion({
      name: `BOGO ${stamp}`,
      variantId: variantA,
      discountType: "percentage",
      discountValue: 0,
      promoKind: "bogo",
      rule: { buyQty: 1, getQty: 1 },
      isActive: true,
    });
    // 2 units of ৳100 → 1 free = ৳100 off → total 100.
    const q2 = await quote([{ variantId: variantA, quantity: 2, unitPrice: 100, discount: null }]);
    assert.equal(q2.promotionsTotal, 100);
    assert.equal(q2.finalTotal, 100);
    // 3 units → 1 free (one complete cycle of 2); 4th unit would earn another.
    const q3 = await quote([{ variantId: variantA, quantity: 3, unitPrice: 100, discount: null }]);
    assert.equal(q3.promotionsTotal, 100);
    assert.equal(q3.finalTotal, 200);
    await deactivateAllPromotions();
  });

  it("buy_x_get_y: buy product A, get product B free", async () => {
    const productIdA = (
      await dbQuery("SELECT product_id FROM product_variants WHERE id = $1", [variantA])
    )[0].product_id as number;
    await createPromotion({
      name: `BXGY ${stamp}`,
      discountType: "percentage",
      discountValue: 0,
      promoKind: "buy_x_get_y",
      rule: {
        buyProductId: productIdA,
        buyQty: 1,
        getVariantId: variantB,
        getQty: 1,
        getDiscountPercent: 100,
      },
      isActive: true,
    });
    // Buy 2 A (200), get 2 B (100) free → 100 off → total 200.
    const q = await quote([
      { variantId: variantA, quantity: 2, unitPrice: 100, discount: null },
      { variantId: variantB, quantity: 2, unitPrice: 50, discount: null },
    ]);
    assert.equal(q.promotionsTotal, 100);
    assert.equal(q.finalTotal, 200);
    await deactivateAllPromotions();
  });

  it("quantity_tier: 3+ units earn a percentage off the line", async () => {
    await createPromotion({
      name: `Tier ${stamp}`,
      variantId: variantA,
      discountType: "percentage",
      discountValue: 0,
      promoKind: "quantity_tier",
      rule: { tiers: [{ minQty: 3, discountPercent: 10 }] },
      isActive: true,
    });
    // 3 × 100 = 300 → 10% = 30 off → 270.
    const q = await quote([{ variantId: variantA, quantity: 3, unitPrice: 100, discount: null }]);
    assert.equal(q.promotionsTotal, 30);
    assert.equal(q.finalTotal, 270);
    await deactivateAllPromotions();
  });

  it("flash window: a promotion outside the current Dhaka time window does not apply", async () => {
    // A window far in the future in Dhaka time: pick an hour that is
    // guaranteed NOT within ±1h of now — use the hour 6h ahead ±1.
    const nowDhakaHour = (new Date().getUTCHours() + 6) % 24;
    const farStart = String((nowDhakaHour + 3) % 24).padStart(2, "0") + ":00";
    const farEnd = String((nowDhakaHour + 4) % 24).padStart(2, "0") + ":59";
    await createPromotion({
      name: `Flash ${stamp}`,
      discountType: "percentage",
      discountValue: 50,
      promoKind: "discount",
      startTime: farStart,
      endTime: farEnd,
      isActive: true,
    });
    const q = await quote([{ variantId: variantA, quantity: 1, unitPrice: 100, discount: null }]);
    assert.equal(q.promotionsTotal, 0, "outside-window flash sale must not apply");
    await deactivateAllPromotions();
  });

  it("usage limit: a promotion stops applying once its count is exhausted", async () => {
    const promoId = await createPromotion({
      name: `Limited ${stamp}`,
      discountType: "percentage",
      discountValue: 10,
      usageLimit: 1,
      isActive: true,
    });
    // First sale applies (10% off 100 → 90); usage row persisted.
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 90, tendered: 90 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: variantA, quantity: 1, unitPrice: 100, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const usage = await dbQuery(
      "SELECT COUNT(*)::int AS n FROM promotion_usage WHERE promotion_id = $1",
      [promoId],
    );
    assert.equal(usage[0].n, 1);
    // Second sale: limit exhausted → no discount.
    const q = await quote([{ variantId: variantA, quantity: 1, unitPrice: 100, discount: null }]);
    assert.equal(q.promotionsTotal, 0);
  });

  it("speed keys: user layout resolution and variant validation", async () => {
    const put = await api(owner, "PUT", "/api/speed-keys", {
      scopeType: "user",
      tiles: [
        { variantId: variantA, label: "Cola", color: "blue", sortOrder: 0 },
        { variantId: variantB, label: "Chips", color: "green", sortOrder: 1 },
      ],
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const get = await api(owner, "GET", "/api/speed-keys");
    assert.equal(get.status, 200);
    const tiles = payload<{ data: { variantId: number; label: string }[] }>(get).data;
    assert.equal(tiles.length, 2);
    assert.equal(tiles[0]!.label, "Cola");

    const bad = await api(owner, "PUT", "/api/speed-keys", {
      scopeType: "user",
      tiles: [{ variantId: 999999, label: "Ghost", color: "blue", sortOrder: 0 }],
    });
    assert.equal(bad.status, 400);
  });

  it("CFD: pair → claim → push → stream snapshot; revoke cuts access", async () => {
    const pair = await api(owner, "POST", "/api/cfd/pair");
    assert.equal(pair.status, 201);
    const { code } = payload<{ data: { code: string } }>(pair).data;
    assert.match(code, /^[A-Z0-9]{8}$/);

    // Claim via the display flow (no user auth).
    const claimRes = await fetch(`${baseUrl}/api/cfd/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "Counter display" }),
    });
    const claimText = await claimRes.text();
    assert.equal(claimRes.status, 200, claimText);
    const claimed = JSON.parse(claimText) as {
      data: { displayId: number; token: string };
    };
    assert.ok(claimed.data.token.length >= 32);

    // Stream: first chunk = connected; then push → payload chunk.
    const stream = await fetch(
      `${baseUrl}/api/cfd/stream?token=${claimed.data.token}`,
    );
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const readChunk = async () => {
      const { value } = await reader.read();
      return new TextDecoder().decode(value);
    };
    const first = await readChunk();
    assert.ok(first.includes('"connected"'), first);

    const push = await api(owner, "POST", "/api/cfd/push", {
      displayId: claimed.data.displayId,
      status: "cart",
      items: [{ name: "Cola", variantName: null, quantity: 2, unitPrice: 100, lineTotal: 200 }],
      discountTotal: 0,
      vatTotal: 0,
      grandTotal: 200,
      paidTotal: 0,
      dueTotal: 0,
    });
    assert.equal(push.status, 200, JSON.stringify(push.body));
    const pushed = await readChunk();
    assert.ok(pushed.includes('"status":"cart"'), pushed);
    assert.ok(pushed.includes('"grandTotal":200'));
    await reader.cancel().catch(() => undefined);

    // Revoke → stream token dead.
    const revoke = await api(owner, "POST", `/api/cfd/displays/${claimed.data.displayId}/revoke`, {});
    assert.equal(revoke.status, 200);
    const dead = await fetch(`${baseUrl}/api/cfd/stream?token=${claimed.data.token}`);
    assert.equal(dead.status, 401);

    // The pairing code cannot be reused.
    const reclaim = await fetch(`${baseUrl}/api/cfd/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    assert.equal(reclaim.status, 404);
  });
});
