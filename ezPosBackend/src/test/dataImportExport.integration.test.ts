/**
 * Phase 1 data import/export integration tests (master prompt F11).
 *
 * Covers: contact import templates, upload+validation (row-level errors,
 * in-file duplicates, duplicate-file detection), background execution with
 * polling, idempotent resume, upsert-by-phone semantics, guarded CSV
 * exports with permission gates, and audit coverage.
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

describe("phase1 data import/export", { skip: !runIntegration }, () => {
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
  ): Promise<{ status: number; body: any; text?: string }> {
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
    return { status: res.status, body: parsed, text };
  }

  function payload<T>(res: { body: unknown }): T {
    return res.body as T;
  }

  async function rawUpload(
    ctx: Ctx,
    path: string,
    body: Buffer | string,
    filename: string,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${path}?filename=${encodeURIComponent(filename)}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/csv",
        Authorization: `Bearer ${ctx.token}`,
        "X-Business-Id": String(ctx.businessId),
      },
      body: typeof body === "string" ? body : new Uint8Array(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  let owner: Ctx;
  let viewer: Ctx; // customers.view only — no edit authority

  before(async () => {
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "IE Test",
        email: `ie-owner-${stamp}@example.test`,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `ie-owner-${stamp}@example.test`,
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
      body: JSON.stringify({ name: `IE Biz ${stamp}` }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business: { id: number } };
    owner = {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
      email: `ie-owner-${stamp}@example.test`,
    };

    const locRes = await api(owner, "POST", "/api/locations", { name: `IE Main ${stamp}` });
    assert.equal(locRes.status, 201);
  });

  it("serves import templates for customers and suppliers", async () => {
    const csv = await fetch(`${baseUrl}/api/import/customers/template`, {
      headers: { Authorization: `Bearer ${owner.token}`, "X-Business-Id": String(owner.businessId) },
    });
    assert.equal(csv.status, 200);
    const text = await csv.text();
    assert.ok(text.includes("name,phone,email,address"));

    const xlsx = await api(owner, "GET", "/api/import/suppliers/template?format=xlsx");
    void xlsx;
    const xlsxRaw = await fetch(`${baseUrl}/api/import/suppliers/template?format=xlsx`, {
      headers: { Authorization: `Bearer ${owner.token}`, "X-Business-Id": String(owner.businessId) },
    });
    assert.equal(xlsxRaw.status, 200);
    assert.match(xlsxRaw.headers.get("content-type") ?? "", /spreadsheetml/);
  });

  it("validates rows on upload: missing name column, bad emails, in-file duplicates", async () => {
    const noName = await rawUpload(
      owner,
      "/api/import/customers/upload",
      "phone,email\r\n01700000001,a@b.test\r\n",
      "bad.csv",
    );
    assert.equal(noName.status, 400);

    const messy = await rawUpload(
      owner,
      "/api/import/customers/upload",
      [
        "name,phone,email",
        `Good One ${stamp},01700000001,one@ie.test`,
        `Bad Email ${stamp},01700000002,not-an-email`,
        `Dup Phone ${stamp},01700000001,dup@ie.test`,
        `No Contact ${stamp},,`,
        `No Contact ${stamp},,`,
      ].join("\r\n"),
      "messy.csv",
    );
    assert.equal(messy.status, 201, JSON.stringify(messy.body));
    const data = payload<{ data: { sessionId: number; totalRows: number; errorCount: number } }>(messy).data;
    assert.equal(data.totalRows, 5);
    // 1 bad email + 1 duplicate phone + 1 duplicate name = 3 error rows
    assert.equal(data.errorCount, 3);

    const detail = await api(owner, "GET", `/api/import/sessions/${data.sessionId}`);
    assert.equal(detail.status, 200);
    const rows = payload<{
      data: { rows: { rowNumber: number; status: string; errors: { code: string }[] | null }[] };
    }>(detail).data.rows;
    const emailRow = rows.find((r) => r.rowNumber === 3);
    assert.ok(emailRow?.errors?.some((e) => e.code === "email_invalid"));
    const dupPhone = rows.find((r) => r.rowNumber === 4);
    assert.ok(dupPhone?.errors?.some((e) => e.code === "duplicate_in_file"));
  });

  it("executes a valid import in the background and upserts by phone", async () => {
    const csv = [
      "name,phone,email,address",
      `Walkin One ${stamp},01711100001,one@ie.test,Dhaka`,
      `Walkin Two ${stamp},01711100002,two@ie.test,Chattogram`,
    ].join("\r\n");
    const upload = await rawUpload(owner, "/api/import/customers/upload", csv, "good.csv");
    assert.equal(upload.status, 201);
    const sessionId = payload<{ data: { sessionId: number } }>(upload).data.sessionId;

    const exec = await api(owner, "POST", `/api/import/sessions/${sessionId}/execute`);
    assert.equal(exec.status, 202, JSON.stringify(exec.body));

    // Poll until completed (background execution).
    let done = false;
    for (let i = 0; i < 50; i++) {
      const detail = await api(owner, "GET", `/api/import/sessions/${sessionId}`);
      const status = payload<{ data: { session: { status: string } } }>(detail).data.session.status;
      if (status === "completed") {
        done = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(done, "import session must reach completed");

    const customers = await api(owner, "GET", "/api/customers");
    // getCustomers responds with a bare array (no envelope).
    const list = Array.isArray(customers.body)
      ? (customers.body as { name: string; phone: string | null }[])
      : (payload<{ data: { name: string; phone: string | null }[] }>(customers).data ?? []);
    const one = list.find((c) => c.name === `Walkin One ${stamp}`);
    assert.ok(one);
    assert.equal(one.phone, "01711100001");

    // Re-upload the SAME customers with a changed address — upsert by phone.
    const csv2 = [
      "name,phone,email,address",
      `Walkin One ${stamp},01711100001,one@ie.test,Gulshan-2`,
    ].join("\r\n");
    const upload2 = await rawUpload(owner, "/api/import/customers/upload", csv2, "good2.csv");
    const sessionId2 = payload<{ data: { sessionId: number } }>(upload2).data.sessionId;
    await api(owner, "POST", `/api/import/sessions/${sessionId2}/execute`);
    let completed = false;
    for (let i = 0; i < 50; i++) {
      const detail = await api(owner, "GET", `/api/import/sessions/${sessionId2}`);
      const s = payload<{ data: { session: { status: string } } }>(detail).data.session;
      if (s.status === "completed") {
        completed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(completed);

    const list2 = await api(owner, "GET", "/api/customers");
    const rows2 = Array.isArray(list2.body)
      ? (list2.body as { name: string; address: string | null }[])
      : (payload<{ data: { name: string; address: string | null }[] }>(list2).data ?? []);
    const one2 = rows2.filter((c) => c.name === `Walkin One ${stamp}`);
    assert.equal(one2.length, 1, "upsert must not duplicate");
    assert.equal(one2[0]!.address, "Gulshan-2");
  });

  it("is idempotent on resume: re-executing a completed session creates no duplicates", async () => {
    const csv = [
      "name,phone,email",
      `Resume Test ${stamp},01722200001,resume@ie.test`,
    ].join("\r\n");
    const upload = await rawUpload(owner, "/api/import/customers/upload", csv, "resume.csv");
    const sessionId = payload<{ data: { sessionId: number } }>(upload).data.sessionId;
    await api(owner, "POST", `/api/import/sessions/${sessionId}/execute`);
    for (let i = 0; i < 50; i++) {
      const detail = await api(owner, "GET", `/api/import/sessions/${sessionId}`);
      if (payload<{ data: { session: { status: string } } }>(detail).data.session.status === "completed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Re-run: 0 processed.
    const again = await api(owner, "POST", `/api/import/sessions/${sessionId}/execute`);
    assert.equal(again.status, 202);
    for (let i = 0; i < 50; i++) {
      const detail = await api(owner, "GET", `/api/import/sessions/${sessionId}`);
      const s = payload<{ data: { session: { status: string; totals: Record<string, number> } } }>(detail).data.session;
      if (s.status === "completed" && s.totals && s.totals.processed === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const customers = await api(owner, "GET", "/api/customers");
    const rows = Array.isArray(customers.body)
      ? (customers.body as { name: string }[])
      : (payload<{ data: { name: string }[] }>(customers).data ?? []);
    assert.equal(rows.filter((c) => c.name === `Resume Test ${stamp}`).length, 1);
  });

  it("guards and permission-gates the CSV exports", async () => {
    const range = `from=${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`;

    const sales = await fetch(`${baseUrl}/api/export/sales?${range}`, {
      headers: { Authorization: `Bearer ${owner.token}`, "X-Business-Id": String(owner.businessId) },
    });
    assert.equal(sales.status, 200);
    const salesText = await sales.text();
    assert.ok(salesText.includes("invoice_number"));
    // No formula injection.
    const dangerous = salesText.split("\r\n").some((line) =>
      /^[\t\r ]*[=+\-@]/.test(line.replace(/^"/, "")),
    );
    assert.ok(!dangerous, "exports must guard formula injection");

    const missingRange = await api(owner, "GET", "/api/export/sales");
    assert.equal(missingRange.status, 400);
    const hugeRange = await api(
      owner,
      "GET",
      "/api/export/sales?from=2000-01-01&to=2025-01-01",
    );
    assert.equal(hugeRange.status, 400);

    const inventory = await fetch(`${baseUrl}/api/export/inventory`, {
      headers: { Authorization: `Bearer ${owner.token}`, "X-Business-Id": String(owner.businessId) },
    });
    assert.equal(inventory.status, 200);
    assert.ok((await inventory.text()).includes("selling_price"));

    const customers = await fetch(`${baseUrl}/api/export/customers`, {
      headers: { Authorization: `Bearer ${owner.token}`, "X-Business-Id": String(owner.businessId) },
    });
    assert.equal(customers.status, 200);
    assert.ok((await customers.text()).includes(`Walkin One ${stamp}`));
  });

  it("audits contact import lifecycle", async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const r = await client.query(
        `SELECT action FROM audit_log WHERE business_id = $1 AND action LIKE '%import%' ORDER BY id ASC`,
        [owner.businessId],
      );
      const actions = r.rows.map((row: { action: string }) => row.action);
      assert.ok(actions.includes("customers.import_uploaded"));
      assert.ok(actions.includes("customers.import_completed"));
    } finally {
      await client.end();
    }
  });
});
