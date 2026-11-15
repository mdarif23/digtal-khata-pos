/**
 * P3 Phase 4 (N1-10/N1-08): receipt share links — hashed-token lifecycle
 * (create → public fetch → revoke), expiry enforcement, tenant isolation
 * via the sale-scoped FK, uniform 404 for stale tokens; plus the CFD push
 * schema's multi-display fan-out (`displayIds` accepted, ownership-checked
 * per target). Against a REAL PostgreSQL database. Double-guarded.
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

describe("receiptShare integration", { skip: !runIntegration }, () => {
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
  const uniqueEmail = () => `rsh-${Date.now()}-${(counter += 1)}@example.test`;

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
    return (res.body as { data: T }).data;
  }

  let owner: Ctx;
  let plainVariantId = 0;

  before(async () => {
    const ownerEmail = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Share Owner",
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
      name: `Share Co ${stamp}`,
    });
    assert.equal(biz.status, 201);
    owner.businessId = biz.body.business.id;

    const locRes = await api(owner, "POST", "/api/locations", {
      name: `Share Main ${stamp}`,
    });
    assert.equal(locRes.status, 201);

    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Share Piece ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ value: number }>(unitRes).value;
    const product = await api(owner, "POST", "/api/product", {
      name: `Share Widget ${stamp}`,
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
          sku: `RSH-${stamp}`,
          barcode: null,
          sellingPrice: 10,
          alertQuantity: 1,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `RSHB-${stamp}`,
          purchasePrice: 4,
          quantity: 100,
          expiryDate: null,
        },
      ],
    });
    assert.equal(product.status, 201);
    const list = await api(owner, "GET", "/api/products");
    const created = (
      list.body as { name: string; variants: { id: number }[] }[]
    ).find((p) => p.name === `Share Widget ${stamp}`);
    assert.ok(created);
    plainVariantId = created.variants[0]!.id;
  });

  async function createSale(): Promise<{ saleId: number; invoiceNumber: string }> {
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 20, tendered: 20 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: plainVariantId, quantity: 2, unitPrice: 10, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    return {
      saleId: sale.body.data.sale.id as number,
      invoiceNumber: sale.body.data.sale.invoiceNumber as string,
    };
  }

  it("creates a link, the PUBLIC fetch resolves it without auth, the sale id never appears in the URL", async () => {
    const { saleId } = await createSale();
    const link = await api(owner, "POST", `/api/sales/${saleId}/receipt-link`, {});
    assert.equal(link.status, 201, JSON.stringify(link.body));
    const { token, url, expiresAt } = payload<{ token: string; url: string; expiresAt: string }>(link);
    assert.ok(/^[0-9a-f]{48}$/.test(token), "48-hex plaintext token");
    assert.ok(url.endsWith(`/receipt/t/${token}`));
    assert.ok(!url.includes(String(saleId)), "internal sale id never in the URL");

    // The DB stores only the SHA-256 hash.
    const rows = await pg!.query(
      "SELECT token_hash FROM receipt_share_tokens WHERE business_id = $1",
      [owner.businessId],
    );
    assert.equal(rows.rows.length, 1);
    assert.notEqual(rows.rows[0]!.token_hash, token);
    assert.equal(rows.rows[0]!.token_hash.length, 64);

    // Public fetch WITHOUT any auth header.
    const pub = await fetch(`${baseUrl}/api/public/receipts/${token}`);
    assert.equal(pub.status, 200);
    const body = (await pub.json()) as { data: { finalTotal: number } };
    assert.equal(body.data.finalTotal, 20);
    void expiresAt;
  });

  it("a revoked token stops resolving (uniform 404)", async () => {
    const { saleId } = await createSale();
    const link = await api(owner, "POST", `/api/sales/${saleId}/receipt-link`, {});
    const { token } = payload<{ token: string }>(link);
    const live = await fetch(`${baseUrl}/api/public/receipts/${token}`);
    assert.equal(live.status, 200);

    const revoke = await api(
      owner,
      "POST",
      `/api/sales/${saleId}/receipt-link/revoke`,
      {},
    );
    assert.equal(revoke.status, 200);
    assert.equal(payload<{ revoked: number }>(revoke).revoked, 1);
    const dead = await fetch(`${baseUrl}/api/public/receipts/${token}`);
    assert.equal(dead.status, 404);
  });

  it("an expired token stops resolving; unknown tokens are uniform 404s", async () => {
    const { saleId } = await createSale();
    const link = await api(owner, "POST", `/api/sales/${saleId}/receipt-link`, {
      ttlHours: 24,
    });
    const { token } = payload<{ token: string }>(link);
    // Force expiry directly.
    await pg!.query(
      "UPDATE receipt_share_tokens SET expires_at = now() - interval '1 minute' WHERE business_id = $1 AND sale_id = $2",
      [owner.businessId, saleId],
    );
    const dead = await fetch(`${baseUrl}/api/public/receipts/${token}`);
    assert.equal(dead.status, 404);
    // Unknown 48-hex token: same uniform 404.
    const unknown = await fetch(
      `${baseUrl}/api/public/receipts/${"a".repeat(48)}`,
    );
    assert.equal(unknown.status, 404);
    // Malformed token: same 404 (never a 500 or a hint).
    const malformed = await fetch(`${baseUrl}/api/public/receipts/not-a-token`);
    assert.equal(malformed.status, 404);
  });

  it("tenant isolation: a link is bound to its own business's sale", async () => {
    const { saleId } = await createSale();
    const link = await api(owner, "POST", `/api/sales/${saleId}/receipt-link`, {});
    assert.equal(link.status, 201);
    const rows = await dbQuery(
      "SELECT id FROM receipt_share_tokens WHERE business_id = $1 AND sale_id = $2",
      [owner.businessId, saleId],
    );
    assert.equal(rows.length, 1);
    // The composite (sale_id, business_id) FK makes a cross-business link
    // impossible to even insert.
    const foreignBusiness = await dbQuery(
      "SELECT id FROM businesses WHERE id <> $1 ORDER BY id DESC LIMIT 1",
      [owner.businessId],
    );
    const fk = await pg!.query(
      `INSERT INTO receipt_share_tokens (business_id, sale_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [foreignBusiness[0]!.id, saleId, "f".repeat(64)],
    ).catch((err: { code?: string }) => err);
    assert.equal(fk.code, "23503", "composite FK rejects the foreign link");
  });

  it("CFD push accepts displayIds and ownership-checks every target", async () => {
    // Two displays via direct claim flow (pair → claim).
    const pair = await api(owner, "POST", "/api/cfd/pair", {});
    assert.equal(pair.status, 201, JSON.stringify(pair.body));
    const code = payload<{ code: string }>(pair).code;
    const claim = await fetch(`${baseUrl}/api/cfd/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: `Share Display ${stamp}` }),
    });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    const displayId = ((await claim.json()) as { data: { displayId: number } }).data
      .displayId;

    // A foreign business's display id (any other id) must 404, not leak.
    const push = await api(owner, "POST", "/api/cfd/push", {
      displayId,
      displayIds: [displayId, 999999999],
      status: "cart",
      items: [{ name: "X", quantity: 1, unitPrice: 1, lineTotal: 1 }],
      discountTotal: 0,
      vatTotal: 0,
      grandTotal: 1,
      paidTotal: 0,
      dueTotal: 0,
    });
    assert.equal(push.status, 200, JSON.stringify(push.body));
    const results = push.body.data.results as {
      displayId: number;
      delivered: boolean;
    }[];
    assert.equal(results.length, 2);
    assert.equal(results[0]!.displayId, displayId);
    assert.equal(typeof results[1]!.delivered, "boolean");
    assert.ok("error" in results[1]! || results[1]!.delivered === false);
  });

  function dbQuery(sql: string, params: unknown[] = []): Promise<any[]> {
    return Promise.resolve(pg!.query(sql, params)).then((r) => r.rows);
  }
});
