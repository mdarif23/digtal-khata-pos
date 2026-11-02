/**
 * Attendance / timeclock integration tests (Module 8): clock-in/out flow,
 * double-clock rejection, breaks, approval permissions, and the hours
 * summary.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("attendance integration", { skip: !runIntegration }, () => {
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
    `att-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;

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

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Worker", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Attendance Biz ${Date.now()}` }),
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
  });

  it("starts not clocked in; clock-in works exactly once at a time", async () => {
    const status = await api("GET", "/api/attendance/me");
    assert.equal(status.status, 200);
    assert.equal(status.json.data.clockedIn, false);

    const first = await api("POST", "/api/attendance/clock-in", { note: "morning shift" });
    assert.equal(first.status, 201);
    const double = await api("POST", "/api/attendance/clock-in", {});
    assert.equal(double.status, 409);
    assert.match(double.json.message ?? "", /already clocked in/);

    const now = await api("GET", "/api/attendance/me");
    assert.equal(now.json.data.clockedIn, true);
  });

  it("manages breaks: one open break at a time; break requires clock-in", async () => {
    const start = await api("POST", "/api/attendance/break/start");
    assert.equal(start.status, 201);
    const again = await api("POST", "/api/attendance/break/start");
    assert.equal(again.status, 409);
    const end = await api("POST", "/api/attendance/break/end");
    assert.equal(end.status, 200);
    const endAgain = await api("POST", "/api/attendance/break/end");
    assert.equal(endAgain.status, 409);
  });

  it("clocks out with hours computed; the record is immutable afterwards", async () => {
    const out = await api("POST", "/api/attendance/clock-out", { note: "end of shift" });
    assert.equal(out.status, 200);
    assert.ok(out.json.data.clock_out !== null);

    const history = await api("GET", "/api/attendance/me/history");
    assert.equal(history.status, 200);
    const record = (history.json.data as { workedHours: number | null }[]).find(
      (r) => r.workedHours !== null,
    );
    assert.ok(record, "closed record has worked hours");
    assert.ok((record.workedHours ?? 0) >= 0);

    // Clock-out again without an open record → 409.
    const again = await api("POST", "/api/attendance/clock-out", {});
    assert.equal(again.status, 409);
  });

  it("the owner (attendance.manage) sees all records and approves once", async () => {
    const all = await api("GET", "/api/attendance");
    assert.equal(all.status, 200);
    const rows = all.json.data as { id: number; approvedAt: string | null; workedHours: number | null }[];
    assert.ok(rows.length >= 1);
    const unapproved = rows.find((r) => r.approvedAt === null)!;

    const approve = await api("POST", `/api/attendance/${unapproved.id}/approve`);
    assert.equal(approve.status, 200);
    const approveAgain = await api("POST", `/api/attendance/${unapproved.id}/approve`);
    assert.equal(approveAgain.status, 404);
  });

  it("builds the per-user hours summary", async () => {
    const summary = await api("GET", "/api/attendance/summary?days=30");
    assert.equal(summary.status, 200);
    const rows = summary.json.data as {
      userName: string;
      shifts: number;
      workedHours: number;
      breakHours: number;
    }[];
    assert.ok(rows.length >= 1);
    const firstRow = rows[0]!;
    assert.ok(firstRow.shifts >= 1);
    assert.ok(firstRow.workedHours >= 0);
    assert.ok(firstRow.breakHours >= 0);
  });
});
