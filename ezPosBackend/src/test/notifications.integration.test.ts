/**
 * Notification center integration tests (Module 14): stock-alert generation
 * on sales (low + out-of-stock), same-day deduplication, per-user read
 * state, and muting.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("notifications integration", { skip: !runIntegration }, () => {
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

  const uniqueEmail = () =>
    `notif-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let unitId = 0;
  let customerId = 0;
  let variantId = 0;

  async function api(method: string, path: string, body?: unknown) {
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

  async function sell(quantity: number) {
    const res = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "cash", amount: 50 * quantity, tendered: 50 * quantity }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity, unitPrice: 50, discount: null }],
    });
    assert.equal(res.status, 201);
  }

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Notif Test", email, password: "strong-password-123" }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    token = ((await login.json()) as { accessToken: string }).accessToken;
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: `Notif Biz ${Date.now()}` }),
    });
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
    unitId = unit.json.data.value;
    const cust = await api("POST", "/api/customers", {
      name: "Notif Customer",
      phone: "1711000017",
    });
    customerId = cust.json.id;

    // alertQuantity 3 → crossing it and hitting zero both notify.
    const prodRes = await api("POST", "/api/product", {
      name: "Notif Product",
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
          sellingPrice: 50,
          alertQuantity: 3,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: 25,
          quantity: 5,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prodRes.status, 201);
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find(
      (p) => p.name === "Notif Product",
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    variantId = (detail.json as { variants: { id: number }[] }).variants[0]!.id;
  });

  it("a sale crossing the alert level generates a low-stock notification", async () => {
    // 5 → 2 crosses alertQuantity 3.
    await sell(3);
    const list = await api("GET", "/api/notifications");
    assert.equal(list.status, 200);
    const low = (list.json.data as { kind: string; title: string }[]).find(
      (n) => n.kind === "low_stock",
    );
    assert.ok(low, "low-stock notification generated");
    assert.match(low.title, /running low/);
  });

  it("the same alert does not repeat on the same day (deduplicated)", async () => {
    await sell(1); // still below the alert level
    const list = await api("GET", "/api/notifications");
    const lows = (list.json.data as { kind: string }[]).filter(
      (n) => n.kind === "low_stock",
    );
    assert.equal(lows.length, 1, "one low-stock notification for the day");
  });

  it("hitting zero generates a critical out-of-stock notification", async () => {
    await sell(1); // 1 → 0
    const list = await api("GET", "/api/notifications");
    const out = (list.json.data as { kind: string; severity: string }[]).find(
      (n) => n.kind === "out_of_stock",
    );
    assert.ok(out, "out-of-stock notification generated");
    assert.equal(out.severity, "critical");
  });

  it("read state is per user: unread count, mark read, mark all", async () => {
    const unread = await api("GET", "/api/notifications/unread-count");
    assert.ok(Number(unread.json.data.count) >= 2);

    const list = await api("GET", "/api/notifications");
    const first = (list.json.data as { id: number; readAt: string | null }[])[0]!;
    assert.equal(first.readAt, null);
    const mark = await api("POST", "/api/notifications/read", {
      ids: [first.id],
    });
    assert.equal(mark.status, 200);

    const after = await api("GET", "/api/notifications/unread-count");
    assert.equal(
      Number(after.json.data.count),
      Number(unread.json.data.count) - 1,
    );

    const all = await api("POST", "/api/notifications/read-all");
    assert.equal(all.status, 200);
    const zero = await api("GET", "/api/notifications/unread-count");
    assert.equal(Number(zero.json.data.count), 0);
  });

  it("muted kinds are filtered for this user only", async () => {
    const mute = await api("POST", "/api/notifications/prefs", {
      kind: "out_of_stock",
      muted: true,
    });
    assert.equal(mute.status, 200);

    const list = await api("GET", "/api/notifications");
    const kinds = (list.json.data as { kind: string }[]).map((n) => n.kind);
    assert.ok(!kinds.includes("out_of_stock"), "muted kind filtered");
    assert.ok(kinds.includes("low_stock"), "other kinds still visible");

    const prefs = await api("GET", "/api/notifications/prefs");
    const pref = (prefs.json.data as { kind: string; muted: boolean }[]).find(
      (p) => p.kind === "out_of_stock",
    );
    assert.equal(pref?.muted, true);
  });
});
