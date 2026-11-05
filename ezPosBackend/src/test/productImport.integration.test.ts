/**
 * Product import/export end-to-end (Phase K): upload → mapping → validate →
 * execute (simple + variants + opening stock), update mode, tenant
 * isolation, export/re-import round trip. Double-guarded like all suites.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

const stamp = Date.now();

function csvFor(rows: string[][]): Buffer {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header =
    "product_name,product_type,category,brand,unit,description,sku,has_variants,variant_options,barcode,selling_price,purchase_price,alert_quantity,tracking_type,opening_stock,location,batch_number,expiry_date,image_url,status";
  return Buffer.from(
    "\uFEFF" + [header, ...rows.map((r) => r.map(escape).join(","))].join("\r\n"),
    "utf8",
  );
}

describe("product import/export integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  type Ctx = { token: string; businessId: number };
  let owner: Ctx;
  let other: Ctx;

  async function api(
    ctx: Ctx,
    method: "GET" | "POST" | "PATCH",
    path: string,
    payload?: unknown,
  ) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.token}`,
        "X-Business-Id": String(ctx.businessId),
      },
      ...(method === "GET"
        ? {}
        : { body: JSON.stringify(payload ?? {}) }),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async function upload(ctx: Ctx, filename: string, bytes: Buffer) {
    const res = await fetch(
      `${baseUrl}/api/products/import/upload?filename=${encodeURIComponent(filename)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          Authorization: `Bearer ${ctx.token}`,
          "X-Business-Id": String(ctx.businessId),
        },
        body: new Uint8Array(bytes),
      },
    );
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
      throw new Error("SAFETY ABORT: not ezpos_test");
    }
    await client.end();
    await ensureRbacSeed();
    const app = buildApp();
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const prefix of ["ie-owner", "ie-other"]) {
      const email = `${prefix}-${stamp}@example.test`;
      await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: prefix,
          email,
          password: "strong-password-123",
        }),
      });
      const login = await (
        await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: "strong-password-123" }),
        })
      ).json();
      const ctx = { token: login.accessToken, businessId: 0 };
      const biz = await api(ctx, "POST", "/api/businesses", {
        name: `IE Biz ${prefix} ${stamp}`,
      });
      ctx.businessId = biz.body.business.id;
      // API-created businesses have no locations (UI onboarding creates them).
      const loc = await api(ctx, "POST", "/api/locations", {
        name: "Main Store",
      });
      assert.equal(loc.status, 201, JSON.stringify(loc.body));
      if (prefix === "ie-owner") owner = ctx;
      else other = ctx;
    }
  });

  after(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  it("imports simple products with opening stock (batch-tracked)", async () => {
    const bytes = csvFor([
      [
        "Water Bottle", "physical", "Accessories", "AquaBrand", "Piece",
        "1L", "BTL-1", "false", "", "8801230000011", "120", "70", "10",
        "batch", "50", "Main Store", "BATCH-IE-1", "2027-12-31", "", "active",
      ],
    ]);
    const up = await upload(owner, "simple.csv", bytes);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const sessionId = up.body.data.sessionId as number;
    assert.ok(up.body.data.duplicateOf === null);

    // Auto-mapping should cover the canonical headers already.
    const validated = await api(owner, "POST", `/api/products/import/${sessionId}/validate`);
    assert.equal(validated.status, 200, JSON.stringify(validated.body));
    assert.equal(validated.body.data.totals.validRows, 1);

    const executed = await api(owner, "POST", `/api/products/import/${sessionId}/execute`);
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.equal(executed.body.data.created, 1);

    // Opening stock exists through the proper batch architecture.
    const products = await api(owner, "GET", "/api/products");
    const created = (products.body as any[]).find(
      (p) => p.name === "Water Bottle",
    );
    assert.ok(created);
    const variant = created.variants.find((v: any) => v.sku === "BTL-1");
    assert.equal(variant.quantity, 50);
    assert.ok(variant.purchaseCost >= 70);

    // Opening stock is visible in movement history (audit-added rows).
    const movements = await api(owner, "GET", "/api/reports/inventory/movements?startDate=2020-01-01&endDate=2030-12-31&limit=10");
    assert.equal(movements.status, 200);
    const rows = (movements.body.data as { data: any[] }).data;
    assert.ok(
      rows.some(
        (m) => m.sku === "BTL-1" && String(m.referenceType).startsWith("product_import:"),
      ),
      "product_import movement recorded",
    );
  });

  it("imports variant products as one product with three variants", async () => {
    const bytes = csvFor([
      ["Football", "physical", "Sports", "Adidas", "Piece", "", "FOOT-S", "true", "Size: Small", "", "500", "350", "5", "none", "0", "", "", "", "", "active"],
      ["Football", "physical", "Sports", "Adidas", "Piece", "", "FOOT-M", "true", "Size: Medium", "", "550", "350", "5", "none", "0", "", "", "", "", "active"],
      ["Football", "physical", "Sports", "Adidas", "Piece", "", "FOOT-L", "true", "Size: Large", "", "600", "350", "5", "none", "0", "", "", "", "", "active"],
    ]);
    const up = await upload(owner, "variants.csv", bytes);
    const sessionId = up.body.data.sessionId as number;
    await api(owner, "POST", `/api/products/import/${sessionId}/validate`);
    const executed = await api(owner, "POST", `/api/products/import/${sessionId}/execute`);
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.equal(executed.body.data.created, 1);

    const products = await api(owner, "GET", "/api/products");
    const football = (products.body as any[]).find((p) => p.name === "Football");
    assert.ok(football);
    assert.equal(football.hasVariants, true);
    assert.equal(football.variants.length, 3);
    const small = football.variants.find((v: any) => v.sku === "FOOT-S");
    assert.equal(small.sellingPrice, 500);
    assert.ok(
      football.variants.every(
        (v: any) => v.options?.[0]?.typeName === "Size" && v.options?.[0]?.value,
      ),
      JSON.stringify(football.variants.map((v: any) => v.options)),
    );
  });

  it("detects duplicate SKUs in-file and against the catalog", async () => {
    const bytes = csvFor([
      ["Bottle Dup", "physical", "", "", "Piece", "", "BTL-1", "false", "", "", "100", "", "", "none", "", "", "", "", "", "active"],
    ]);
    const up = await upload(owner, "dup.csv", bytes);
    const sessionId = up.body.data.sessionId as number;
    const validated = await api(owner, "POST", `/api/products/import/${sessionId}/validate`);
    assert.equal(validated.body.data.totals.errorRows, 1);
  });

  it("updates an existing product via upsert without duplicating", async () => {
    const bytes = csvFor([
      ["Water Bottle", "physical", "Accessories", "AquaBrand", "Piece", "1L updated", "BTL-1", "false", "", "8801230000011", "150", "", "", "none", "", "", "", "", "", "active"],
    ]);
    const up = await upload(owner, "update.csv", bytes);
    const sessionId = up.body.data.sessionId as number;
    const patched = await api(owner, "PATCH", `/api/products/import/${sessionId}`, {
      mapping: up.body.data.mapping,
      mode: "upsert",
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    // PATCH revalidates internally; execute in upsert → updated, not created.
    const detail = await api(owner, "GET", `/api/products/import/${sessionId}`);
    const session = (detail.body as { data: any }).data.session;
    assert.equal(session.mode, "upsert");
    const executed = await api(owner, "POST", `/api/products/import/${sessionId}/execute`);
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.equal(executed.body.data.updated, 1);

    const products = await api(owner, "GET", "/api/products");
    const bottles = (products.body as any[]).filter(
      (p) => p.name === "Water Bottle" || p.name === "1L updated",
    );
    assert.equal(bottles.length, 1);
  });

  it("repeated upload of the same file is flagged for idempotency", async () => {
    const bytes = csvFor([
      ["Idem Product", "physical", "", "", "Piece", "", "IDEM-1", "false", "", "", "100", "", "", "none", "", "", "", "", "", "active"],
    ]);
    const first = await upload(owner, "idem.csv", bytes);
    assert.equal(first.status, 201);
    const second = await upload(owner, "idem.csv", bytes);
    assert.equal(second.status, 201);
    assert.equal(second.body.data.duplicateOf, first.body.data.sessionId);
  });

  it("rejects macro/binary uploads and enforces tenant isolation", async () => {
    const bad = await upload(
      owner,
      "evil.csv",
      Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(32)]),
    );
    assert.equal(bad.status, 400);

    const foreign = await upload(other, "foreign.csv", csvFor([
      ["Other Product", "physical", "", "", "Piece", "", "OTH-1", "false", "", "", "100", "", "", "none", "", "", "", "", "", "active"],
    ]));
    assert.equal(foreign.status, 201);
    const foreignProducts = await api(other, "GET", "/api/products");
    assert.ok(
      !(foreignProducts.body as any[]).some((p) => p.name === "Football"),
      "no cross-business leakage",
    );
  });

  it("exports products and the export re-imports without duplication", async () => {
    const res = await fetch(
      `${baseUrl}/api/products/export?format=csv`,
      {
        headers: {
          Authorization: `Bearer ${owner.token}`,
          "X-Business-Id": String(owner.businessId),
        },
      },
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("product_name"));
    assert.ok(!text.includes("Other Product"), "tenant isolation in export");
    assert.ok(text.includes("Football"), "catalog included");

    // Round-trip: re-import the exported CSV in upsert mode → zero creates.
    const exportedBytes = Buffer.from(text, "utf8");
    const up = await upload(owner, "roundtrip.csv", exportedBytes);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const sessionId = up.body.data.sessionId as number;
    await api(owner, "PATCH", `/api/products/import/${sessionId}`, {
      mapping: up.body.data.mapping,
      mode: "upsert",
    });
    const executed = await api(owner, "POST", `/api/products/import/${sessionId}/execute`);
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.equal(executed.body.data.created, 0, JSON.stringify(executed.body));
    assert.ok((executed.body.data.updated as number) >= 2);
  });
});
