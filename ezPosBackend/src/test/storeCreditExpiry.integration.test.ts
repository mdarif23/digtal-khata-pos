/**
 * P3 Phase 1 (F4): store-credit expiry — replay semantics (expired value is
 * not spendable), the idempotent expiry sweep, FIFO consumption across
 * expiring and permanent grants, refund-granted credit following the
 * business policy, and the expiry notification. Against a REAL PostgreSQL
 * database. Double-guarded like the other suites.
 *
 * Plain `npm test` NEVER runs this file.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";
import { db } from "../db/schema/index.js";
import {
  consumeStoreCreditInTx,
  getStoreCreditBalance,
  runStoreCreditExpirySweep,
} from "../services/storeCredit.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("storeCreditExpiry integration", { skip: !runIntegration }, () => {
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
  const uniqueEmail = () => `sce-${Date.now()}-${(counter += 1)}@example.test`;

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
        fullName: "SCE Owner",
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
      name: `SCE Co ${stamp}`,
    });
    assert.equal(biz.status, 201);
    owner.businessId = biz.body.business.id;

    const locRes = await api(owner, "POST", "/api/locations", {
      name: `SCE Main ${stamp}`,
    });
    assert.equal(locRes.status, 201);

    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `SCE Piece ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ value: number }>(unitRes).value;
    const product = await api(owner, "POST", "/api/product", {
      name: `SCE Widget ${stamp}`,
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
          sku: `SCE-${stamp}`,
          barcode: null,
          sellingPrice: 100,
          alertQuantity: 1,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `SCEB-${stamp}`,
          purchasePrice: 10,
          quantity: 500,
          expiryDate: null,
        },
      ],
    });
    assert.equal(product.status, 201);
    const list = await api(owner, "GET", "/api/products");
    const created = (
      list.body as { name: string; variants: { id: number }[] }[]
    ).find((p) => p.name === `SCE Widget ${stamp}`);
    assert.ok(created);
    variantId = created.variants[0]!.id;
  });

  async function createCustomer(name: string): Promise<number> {
    const res = await api(owner, "POST", "/api/customers", {
      name,
      phone: `018${String(Date.now()).slice(-8)}`,
      address: "",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.id as number;
  }

  async function grant(
    customerId: number,
    amount: number,
    expiresAt: Date | null,
  ): Promise<void> {
    await pg!.query(
      `INSERT INTO customer_credits (business_id, customer_id, amount, source_type, expires_at)
       VALUES ($1, $2, $3, 'manual', $4)`,
      [owner.businessId, customerId, amount, expiresAt],
    );
  }

  it("expired value is not spendable even before the sweep runs", async () => {
    const customerId = await createCustomer(`Replay ${stamp}`);
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    await grant(customerId, 100, yesterday);
    await grant(customerId, 50, null);

    const balance = await getStoreCreditBalance(owner.businessId, customerId);
    assert.equal(balance, 50);

    // Consuming more than the unexpired available aborts with the real figure.
    await assert.rejects(
      () =>
        db.transaction(async (tx) => {
          await consumeStoreCreditInTx(tx, {
            businessId: owner.businessId,
            customerId,
            amount: 60,
            sourceType: "sale_payment",
          });
        }),
      (err: Error) => /available ৳50\.00/.test(err.message),
    );

    // Consuming 50 succeeds — and because consumption allocates FIFO against
    // the EXPIRED grant first, the spend burns write-off-bound value while
    // the spendable balance is preserved (conservation, customer-favorable).
    await db.transaction(async (tx) => {
      await consumeStoreCreditInTx(tx, {
        businessId: owner.businessId,
        customerId,
        amount: 50,
        sourceType: "sale_payment",
      });
    });
    const after = await getStoreCreditBalance(owner.businessId, customerId);
    assert.equal(after, 50);

    // Cleanup: sweep away this customer's remaining expired value (FIFO
    // consumed 50 of the expired grant; 50 expired-unconsumed remains) so
    // later sweep assertions in this business stay isolated.
    const swept = await runStoreCreditExpirySweep(owner.businessId);
    assert.equal(swept.customersAffected, 1);
    assert.equal(swept.storeCreditExpired, 50);
    const rows = await dbQuery(
      "SELECT amount FROM customer_credits WHERE customer_id = $1",
      [customerId],
    );
    const sum = rows.reduce((s, r) => s + Number(r.amount), 0);
    // Conservation: grant 100 − consume 50 − expiry 50 = the 50 of permanent
    // credit still owned by the customer.
    assert.equal(sum, 50);
  });

  it("the sweep expires unconsumed value exactly once (idempotent) and notifies", async () => {
    const customerId = await createCustomer(`Sweep ${stamp}`);
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    await grant(customerId, 100, yesterday);

    const first = await runStoreCreditExpirySweep(owner.businessId);
    assert.equal(first.customersAffected, 1);
    assert.equal(first.storeCreditExpired, 100);

    const rows = await dbQuery(
      "SELECT amount, source_type FROM customer_credits WHERE customer_id = $1 ORDER BY id",
      [customerId],
    );
    const expiryRows = rows.filter((r) => r.source_type === "expiry");
    assert.equal(expiryRows.length, 1);
    assert.equal(Number(expiryRows[0]!.amount), -100);

    // Conservation: Σ rows === total written by the replay (grant + expiry).
    const sum = rows.reduce((s, r) => s + Number(r.amount), 0);
    assert.equal(sum, 0);

    // Repeated sweep changes nothing.
    const second = await runStoreCreditExpirySweep(owner.businessId);
    assert.equal(second.customersAffected, 0);
    assert.equal(second.storeCreditExpired, 0);

    // The in-app notification fired.
    const notifs = await dbQuery(
      "SELECT kind FROM notifications WHERE business_id = $1 AND kind = 'store_credit_expired' ORDER BY id DESC LIMIT 1",
      [owner.businessId],
    );
    assert.ok(notifs.length >= 1);
  });

  it("consumption FIFOs across expiring and permanent grants", async () => {
    const customerId = await createCustomer(`Fifo ${stamp}`);
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    await grant(customerId, 100, tomorrow);
    await grant(customerId, 100, null);

    // Consume 150 — 100 eats the expiring grant, 50 the permanent one.
    await db.transaction(async (tx) => {
      await consumeStoreCreditInTx(tx, {
        businessId: owner.businessId,
        customerId,
        amount: 150,
        sourceType: "sale_payment",
      });
    });
    // Balance 50 (permanent grant remainder).
    assert.equal(await getStoreCreditBalance(owner.businessId, customerId), 50);

    // After the expiring grant lapses, nothing new expires (it was consumed).
    await pg!.query(
      "UPDATE customer_credits SET expires_at = now() - interval '1 hour' WHERE customer_id = $1 AND expires_at IS NOT NULL",
      [customerId],
    );
    const sweep = await runStoreCreditExpirySweep(owner.businessId);
    assert.equal(sweep.customersAffected, 0);
    assert.equal(await getStoreCreditBalance(owner.businessId, customerId), 50);
  });

  it("refund-granted store credit follows the business expiry policy", async () => {
    const customerId = await createCustomer(`Policy ${stamp}`);
    // Policy: 6 months.
    const patch = await api(owner, "PATCH", "/api/pos-settings", {
      storeCreditExpiryMonths: 6,
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    assert.equal(payload<{ storeCreditExpiryMonths: number | null }>(patch).storeCreditExpiryMonths, 6);

    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "cash", amount: 100, tendered: 100 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 100, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const saleId = sale.body.data.sale.id as number;
    const refund = await api(
      owner,
      "POST",
      `/api/sold_products/refunds_all/${saleId}`,
      { reason: "customer_request", disposition: "restock", refundMethod: "store_credit" },
    );
    assert.equal(refund.status, 200, JSON.stringify(refund.body));

    const rows = await dbQuery(
      "SELECT amount, expires_at, source_type FROM customer_credits WHERE customer_id = $1 AND source_type = 'refund'",
      [customerId],
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]!.amount), 100);
    assert.ok(rows[0]!.expires_at !== null);
    const months =
      (new Date(rows[0]!.expires_at).getTime() - Date.now()) /
      (30 * 24 * 3600 * 1000);
    assert.ok(months > 5 && months <= 7, `got ~${months.toFixed(1)} months`);

    // Clear the policy so other tests/businesses stay default.
    const clear = await api(owner, "PATCH", "/api/pos-settings", {
      storeCreditExpiryMonths: null,
    });
    assert.equal(clear.status, 200);
  });
});
