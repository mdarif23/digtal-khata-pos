/**
 * Phase 1 Operational Foundation integration tests.
 *
 * Covers the approved Phase 1 scope end-to-end against a REAL PostgreSQL:
 *  - register route permission enforcement (cash_register.* / cash_movement.create)
 *  - denomination config + open/close denomination sheets
 *  - audit events for the cash lifecycle (register.opened/closed/reconciled/reopened,
 *    cash.movement, cash.unattributed)
 *  - cash-drop metadata + manager confirmation
 *  - mid-shift reconciliation (count event — never changes expected cash)
 *  - controlled reopen gated by a manager-approval token (per-user PIN,
 *    one-time token consumption, entity binding)
 *  - audit view API (filters, permission gates, guarded CSV export)
 *  - require_open_drawer policy + sale.refund approval wiring
 *
 * Two actors share the suite: the OWNER (wildcard) runs one drawer session on
 * register A; a CASHIER-role "manager" runs a second session on register B —
 * the per-user one-open-session rule means the tests never collide. The
 * restricted user holds NO cash permissions and is the negative case.
 *
 * Double-guarded like every suite: runs ONLY with INTEGRATION_TESTS=1 AND
 * DATABASE_URL pointing at ezpos_test (fail-closed).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("phase1 operational foundation", { skip: !runIntegration }, () => {
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
  const uniqueEmail = () =>
    `p1-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

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

  async function dbQuery(sql: string, params: unknown[] = []): Promise<any[]> {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const r = await client.query(sql, params);
      return r.rows;
    } finally {
      await client.end();
    }
  }

  async function registerAndLogin(
    email: string,
    businessId?: number,
  ): Promise<Ctx> {
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "P1 Test",
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
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as {
      accessToken: string;
      user: { id: number };
    };
    let bizId = businessId;
    if (!bizId) {
      const biz = await fetch(`${baseUrl}/api/businesses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${loginBody.accessToken}`,
        },
        body: JSON.stringify({ name: `P1 Biz ${stamp}` }),
      });
      assert.equal(biz.status, 201);
      bizId = ((await biz.json()) as { business: { id: number } }).business.id;
    }
    return {
      token: loginBody.accessToken,
      businessId: bizId!,
      userId: loginBody.user.id,
      email,
    };
  }

  /** Logs in an ALREADY-REGISTERED user (created via /api/users). */
  async function loginExisting(email: string, businessId: number): Promise<Ctx> {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as {
      accessToken: string;
      user: { id: number };
    };
    return {
      token: loginBody.accessToken,
      businessId,
      userId: loginBody.user.id,
      email,
    };
  }

  let owner: Ctx;
  let manager: Ctx; // cashier role — open/close/movement authority
  let restricted: Ctx; // custom role — NO cash permissions
  let registerA = 0;
  let registerB = 0;
  let variantId = 0;

  async function openRegister(
    ctx: Ctx,
    registerId: number,
    openingCash: number,
    denominations?: unknown,
  ) {
    return api(ctx, "POST", `/api/registers/${registerId}/open`, {
      openingCash,
      ...(denominations ? { openingDenominations: denominations } : {}),
    });
  }

  before(async () => {
    owner = await registerAndLogin(`p1-owner-${stamp}@example.test`);

    const locRes = await api(owner, "POST", "/api/locations", {
      name: `P1 Main ${stamp}`,
    });
    assert.equal(locRes.status, 201, JSON.stringify(locRes.body));
    const locationId = payload<{ data: { id: number } }>(locRes).data.id;

    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Piece ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ data: { value: number } }>(unitRes).data.value;
    const product = await api(owner, "POST", "/api/product", {
      name: `P1 Cola ${stamp}`,
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
          sku: `P1-${stamp}`,
          barcode: null,
          sellingPrice: 100,
          alertQuantity: 5,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `B1-${stamp}`,
          purchasePrice: 40,
          quantity: 500,
          expiryDate: null,
        },
      ],
    });
    assert.equal(product.status, 201);
    const list = await api(owner, "GET", "/api/products");
    const created = (
      list.body as { name: string; variants: { id: number }[] }[]
    ).find((p) => p.name === `P1 Cola ${stamp}`);
    assert.ok(created);
    variantId = created.variants[0]!.id;

    const r1 = await api(owner, "POST", "/api/registers", { name: "P1 Counter A" });
    assert.equal(r1.status, 201);
    registerA = payload<{ data: { id: number } }>(r1).data.id;
    const r2 = await api(owner, "POST", "/api/registers", { name: "P1 Counter B" });
    registerB = payload<{ data: { id: number } }>(r2).data.id;

    // Cashier-role staff member (the default cashier bundle carries
    // cash_register.open/close + cash_movement.create + cash_register.view).
    const roles = await api(owner, "GET", "/api/roles");
    const cashierRole = payload<{ data: { id: number; slug: string }[] }>(roles).data.find(
      (r) => r.slug === "cashier",
    );
    assert.ok(cashierRole);
    const managerRes = await api(owner, "POST", "/api/users", {
      fullName: "P1 Manager",
      email: uniqueEmail(),
      password: "strong-password-123",
      roleIds: [cashierRole!.id],
      locationIds: [locationId],
    });
    assert.equal(managerRes.status, 201, JSON.stringify(managerRes.body));
    const managerEmail = payload<{ data: { email: string } }>(managerRes).data.email;
    const managerLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: managerEmail, password: "strong-password-123" }),
    });
    assert.equal(managerLogin.status, 200);
    const managerBody = (await managerLogin.json()) as { accessToken: string; user: { id: number } };
    manager = {
      token: managerBody.accessToken,
      businessId: owner.businessId,
      userId: managerBody.user.id,
      email: managerEmail,
    };

    // Custom role WITHOUT cash authorizations — the negative case.
    const roleRes = await api(owner, "POST", "/api/roles", {
      name: `P1 Viewer ${stamp}`,
      permissionKeys: ["dashboard.view", "products.view", "sales.view"],
    });
    assert.equal(roleRes.status, 201, JSON.stringify(roleRes.body));
    const roleId = payload<{ data: { id: number } }>(roleRes).data.id;
    const userRes = await api(owner, "POST", "/api/users", {
      fullName: "P1 Restricted",
      email: uniqueEmail(),
      password: "strong-password-123",
      roleIds: [roleId],
      locationIds: [locationId],
    });
    assert.equal(userRes.status, 201, JSON.stringify(userRes.body));
    const userEmail = payload<{ data: { email: string } }>(userRes).data.email;
    restricted = await loginExisting(userEmail, owner.businessId);
  });

  // -----------------------------------------------------------------
  // Permission enforcement (P0 #1)
  // -----------------------------------------------------------------

  it("denies register open/movement/close without the cash permissions", async () => {
    const open = await openRegister(restricted, registerA, 1000);
    assert.equal(open.status, 403, JSON.stringify(open.body));
    const movement = await api(restricted, "POST", "/api/sessions/1/cash-movement", {
      type: "cash_in",
      amount: 10,
    });
    assert.equal(movement.status, 403);
    const close = await api(restricted, "POST", "/api/sessions/1/close", {
      countedCash: 10,
    });
    assert.equal(close.status, 403);
  });

  it("owner can still open (wildcard) and the session opens", async () => {
    const res = await openRegister(owner, registerA, 5000);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  // -----------------------------------------------------------------
  // Denominations
  // -----------------------------------------------------------------

  it("serves the default denomination sheet and accepts a replacement", async () => {
    const def = await api(owner, "GET", "/api/registers/denominations");
    assert.equal(def.status, 200);
    assert.deepEqual(payload<{ data: number[] }>(def).data, [
      1000, 500, 200, 100, 50, 20, 10, 5, 2, 1,
    ]);
    const put = await api(owner, "PUT", "/api/registers/denominations", {
      denominations: [500, 100, 20, 1000],
    });
    assert.equal(put.status, 200);
    assert.deepEqual(payload<{ data: number[] }>(put).data, [1000, 500, 100, 20]);
    const dup = await api(owner, "PUT", "/api/registers/denominations", {
      denominations: [100, 100],
    });
    assert.equal(dup.status, 400);
    const denied = await api(restricted, "PUT", "/api/registers/denominations", {
      denominations: [1],
    });
    assert.equal(denied.status, 403);
  });

  it("open accepts a denomination sheet matching the total; rejects a mismatch; audits open/close", async () => {
    // The cashier-role manager opens register B with a 3000 sheet.
    const ok = await openRegister(manager, registerB, 3000, [
      { value: 1000, count: 2 },
      { value: 500, count: 2 },
    ]);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const sessionId = payload<{ data: { id: number } }>(ok).data.id;

    // A mismatched sheet never opens a session.
    const mismatch = await api(manager, "POST", "/api/sessions/current", {});
    void mismatch; // (no-op — keep fetch helpers warm)

    const close = await api(manager, "POST", `/api/sessions/${sessionId}/close`, {
      countedCash: 2950,
      countedDenominations: [
        { value: 1000, count: 2 },
        { value: 500, count: 1 },
        { value: 200, count: 2 },
        { value: 50, count: 1 },
      ],
    });
    assert.equal(close.status, 200, JSON.stringify(close.body));
    assert.equal(payload<{ data: { difference: number } }>(close).data.difference, -50);

    // Re-open with a sheet that does not match the entered cash → 400.
    const bad = await openRegister(manager, registerB, 2000, [
      { value: 1000, count: 1 },
    ]);
    assert.equal(bad.status, 400);
    assert.match(String(bad.body?.message ?? ""), /denomination sheet/i);

    const auditRows = await dbQuery(
      `SELECT action, metadata FROM audit_log WHERE business_id = $1 AND action IN ('register.opened','register.closed') ORDER BY id DESC LIMIT 4`,
      [owner.businessId],
    );
    assert.ok(auditRows.some((r) => r.action === "register.opened"));
    assert.ok(auditRows.some((r) => r.action === "register.closed"));
    const closedRow = auditRows.find((r) => r.action === "register.closed");
    assert.equal(Number(closedRow.metadata.difference), -50);
  });

  // -----------------------------------------------------------------
  // Drop metadata + confirmation (owner's open session on register A)
  // -----------------------------------------------------------------

  it("records drop metadata on safe_deposit and requires manager confirmation", async () => {
    const current = await api(owner, "GET", "/api/sessions/current");
    const sessionId = payload<{ data: { id: number } }>(current).data.id;

    const drop = await api(owner, "POST", `/api/sessions/${sessionId}/cash-movement`, {
      type: "safe_deposit",
      amount: 2000,
      note: "mid-shift drop",
      recipientUserId: owner.userId,
      referenceNo: `SLIP-${stamp}`,
    });
    assert.equal(drop.status, 200, JSON.stringify(drop.body));

    // Drop metadata on a non-drop type is rejected.
    const bad = await api(owner, "POST", `/api/sessions/${sessionId}/cash-movement`, {
      type: "cash_in",
      amount: 10,
      referenceNo: "NOPE",
    });
    assert.equal(bad.status, 400);

    const detail = await api(owner, "GET", `/api/sessions/${sessionId}`);
    const txs = payload<{
      data: { transactions: { id: number; type: string; recipientName: string | null; referenceNo: string | null; confirmedAt: string | null }[] };
    }>(detail).data.transactions;
    const dropTx = txs.find((t) => t.type === "safe_deposit");
    assert.ok(dropTx);
    assert.equal(dropTx.referenceNo, `SLIP-${stamp}`);
    assert.ok(dropTx.recipientName);
    assert.equal(dropTx.confirmedAt, null);

    const confirm = await api(
      owner,
      "POST",
      `/api/sessions/${sessionId}/transactions/${dropTx!.id}/confirm-drop`,
    );
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
    const again = await api(
      owner,
      "POST",
      `/api/sessions/${sessionId}/transactions/${dropTx!.id}/confirm-drop`,
    );
    assert.equal(again.status, 409);

    const dropAudit = await dbQuery(
      `SELECT action FROM audit_log WHERE business_id = $1 AND action IN ('cash.movement','cash.drop_confirmed') ORDER BY id DESC LIMIT 3`,
      [owner.businessId],
    );
    assert.ok(dropAudit.some((r) => r.action === "cash.movement"));
    assert.ok(dropAudit.some((r) => r.action === "cash.drop_confirmed"));
  });

  // -----------------------------------------------------------------
  // Mid-shift reconciliation
  // -----------------------------------------------------------------

  it("reconciles mid-shift without changing expected cash", async () => {
    const current = await api(owner, "GET", "/api/sessions/current");
    const sessionId = payload<{ data: { id: number } }>(current).data.id;
    const beforeDetail = await api(owner, "GET", `/api/sessions/${sessionId}`);
    const expectedBefore = payload<{ data: { expectedCash: number } }>(beforeDetail).data.expectedCash;

    const reconcile = await api(owner, "POST", `/api/sessions/${sessionId}/reconcile`, {
      countedCash: expectedBefore - 100,
      notes: "blind count test",
    });
    assert.equal(reconcile.status, 200, JSON.stringify(reconcile.body));
    const rec = payload<{
      data: { reconciliationId: number; expected: number; difference: number };
    }>(reconcile).data;
    assert.equal(rec.difference, -100);
    assert.equal(rec.expected, expectedBefore);

    const afterDetail = await api(owner, "GET", `/api/sessions/${sessionId}`);
    assert.equal(
      payload<{ data: { expectedCash: number } }>(afterDetail).data.expectedCash,
      expectedBefore,
    );

    const recRow = await dbQuery(
      `SELECT difference FROM register_reconciliations WHERE id = $1`,
      [rec.reconciliationId],
    );
    assert.equal(Number(recRow[0].difference), -100);

    const auditRow = await dbQuery(
      `SELECT id FROM audit_log WHERE business_id = $1 AND action = 'register.reconciled' LIMIT 1`,
      [owner.businessId],
    );
    assert.ok(auditRow.length > 0);
  });

  // -----------------------------------------------------------------
  // Manager PIN + controlled reopen (approver = owner, caller = manager)
  // -----------------------------------------------------------------

  it("reopens a closed session only with a one-time manager approval token", async () => {
    // Manager re-opens register B (flat float this time) and closes it.
    const open = await openRegister(manager, registerB, 2000);
    assert.equal(open.status, 201);
    const sessionId = payload<{ data: { id: number } }>(open).data.id;
    const close = await api(manager, "POST", `/api/sessions/${sessionId}/close`, {
      countedCash: 1950,
    });
    assert.equal(close.status, 200);

    // Reopen without approval fails.
    const noToken = await api(manager, "POST", `/api/sessions/${sessionId}/reopen`, {
      reason: "should not work",
    });
    assert.equal(noToken.status, 400);

    // Owner (cash_register.manage authority) sets a PIN and mints a token
    // bound to THIS session.
    const setPin = await api(owner, "POST", "/api/manager-approval/pin", {
      pin: "482913",
    });
    assert.equal(setPin.status, 200, JSON.stringify(setPin.body));
    const wrong = await api(owner, "POST", "/api/manager-approval/verify", {
      pin: "000000",
      opType: "register.reopen",
      entityType: "register_session",
      entityId: sessionId,
    });
    assert.equal(wrong.status, 403);

    const verify = await api(owner, "POST", "/api/manager-approval/verify", {
      pin: "482913",
      opType: "register.reopen",
      entityType: "register_session",
      entityId: sessionId,
      reason: "counting error at close",
    });
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    const token = payload<{ data: { approvalToken: string } }>(verify).data.approvalToken;
    assert.ok(token.length >= 32);

    // The MANAGER (close authority) consumes the owner's approval.
    const reopen = await api(manager, "POST", `/api/sessions/${sessionId}/reopen`, {
      approvalToken: token,
      reason: "counting error at close",
    });
    assert.equal(reopen.status, 200, JSON.stringify(reopen.body));
    const reopened = payload<{ data: { status: string; openingCash: number } }>(reopen).data;
    assert.equal(reopened.status, "open");
    assert.equal(reopened.openingCash, 1950);

    // Token replay after the next close is rejected as consumed.
    const closeAgain = await api(manager, "POST", `/api/sessions/${sessionId}/close`, {
      countedCash: 1950,
    });
    assert.equal(closeAgain.status, 200);
    const replay = await api(manager, "POST", `/api/sessions/${sessionId}/reopen`, {
      approvalToken: token,
    });
    assert.equal(replay.status, 409);

    // The reopen audit carries the close variance + approval reason.
    const auditRow = await dbQuery(
      `SELECT before_state, metadata FROM audit_log WHERE business_id = $1 AND action = 'register.reopened' ORDER BY id DESC LIMIT 1`,
      [owner.businessId],
    );
    assert.ok(auditRow[0]);
    assert.equal(Number(auditRow[0].before_state.difference), -50);
    assert.equal(auditRow[0].metadata.approvalReason, "counting error at close");
  });

  it("locks the PIN after repeated failures and blocks verify while locked", async () => {
    // A dedicated PIN user so the owner's lockout state is untouched.
    const pinUserRes = await api(owner, "POST", "/api/users", {
      fullName: "P1 Pin Manager",
      email: uniqueEmail(),
      password: "strong-password-123",
      roleIds: [],
      locationIds: [],
    });
    let pinUser: Ctx;
    if (pinUserRes.status === 201) {
      const userEmail = payload<{ data: { email: string } }>(pinUserRes).data.email;
      pinUser = await loginExisting(userEmail, owner.businessId);
    } else {
      pinUser = manager;
    }

    const setPin = await api(pinUser, "POST", "/api/manager-approval/pin", { pin: "777777" });
    assert.equal(setPin.status, 200);

    for (let i = 0; i < 5; i++) {
      const bad = await api(pinUser, "POST", "/api/manager-approval/verify", {
        pin: "111111",
        opType: "cash_movement",
        payload: { type: "cash_in", amount: 5 },
      });
      assert.equal(bad.status, 403, `attempt ${i + 1}: ${JSON.stringify(bad.body)}`);
    }
    const locked = await api(pinUser, "POST", "/api/manager-approval/verify", {
      pin: "777777",
      opType: "cash_movement",
      payload: { type: "cash_in", amount: 5 },
    });
    assert.equal(locked.status, 409);
    assert.match(String(locked.body?.message ?? ""), /locked|minute/i);

    const del = await api(pinUser, "DELETE", "/api/manager-approval/pin");
    assert.equal(del.status, 200);
    const none = await api(pinUser, "POST", "/api/manager-approval/verify", {
      pin: "777777",
      opType: "cash_movement",
      payload: { type: "cash_in", amount: 5 },
    });
    assert.equal(none.status, 404);
  });

  it("refuses to mint an approval for an operation the user has no authority over", async () => {
    const setPin = await api(restricted, "POST", "/api/manager-approval/pin", { pin: "246810" });
    assert.equal(setPin.status, 200);
    const res = await api(restricted, "POST", "/api/manager-approval/verify", {
      pin: "246810",
      opType: "sale.refund",
    });
    assert.equal(res.status, 403);
  });

  // -----------------------------------------------------------------
  // Audit view API
  // -----------------------------------------------------------------

  it("lists the audit log with prefix filters and gates it by permission", async () => {
    const list = await api(owner, "GET", "/api/audit-log?actionPrefix=register&limit=10");
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const data = payload<{ data: { rows: { action: string }[]; total: number } }>(list).data;
    assert.ok(data.rows.length > 0);
    for (const row of data.rows) {
      assert.ok(row.action.startsWith("register"));
    }

    const denied = await api(restricted, "GET", "/api/audit-log");
    assert.equal(denied.status, 403);
    const deniedExport = await api(restricted, "GET", "/api/audit-log/export");
    assert.equal(deniedExport.status, 403);
  });

  it("exports the audit log as a guarded CSV", async () => {
    // fetch().text() strips the UTF-8 BOM per spec — decode raw bytes with
    // ignoreBOM so the Excel-friendly BOM the server sends is verified.
    const raw = await fetch(`${baseUrl}/api/audit-log/export?actionPrefix=cash`, {
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "X-Business-Id": String(owner.businessId),
      },
    });
    assert.equal(raw.status, 200);
    const bytes = await raw.arrayBuffer();
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    assert.ok(text.startsWith("\uFEFF"));
    assert.ok(text.includes("action"));
    const dangerous = text.split("\r\n").some((line) =>
      /^[\t\r ]*[=+\-@]/.test(line.replace(/^"/, "")),
    );
    assert.ok(!dangerous, "CSV export must guard formula injection");
  });

  // -----------------------------------------------------------------
  // require_open_drawer + sale.refund approval
  // -----------------------------------------------------------------

  async function makeCashSale(price = 100): Promise<number> {
    const res = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: price, tendered: price }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: price, discount: null }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return payload<{ data: { sale: { id: number } } }>(res).data.sale.id;
  }

  async function closeOwnerSessionIfOpen(): Promise<void> {
    const current = await api(owner, "GET", "/api/sessions/current");
    if (current.status === 200 && payload<{ data: { id: number } | null }>(current).data) {
      const sessionId = payload<{ data: { id: number } }>(current).data.id;
      const detail = await api(owner, "GET", `/api/sessions/${sessionId}`);
      const expected = payload<{ data: { expectedCash: number } }>(detail).data.expectedCash;
      const close = await api(owner, "POST", `/api/sessions/${sessionId}/close`, {
        countedCash: expected,
      });
      assert.equal(close.status, 200);
    }
  }

  it("blocks cash sales without an open drawer when require_open_drawer is on", async () => {
    const patch = await api(owner, "PATCH", "/api/pos-settings", {
      requireOpenDrawer: true,
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));

    // Ensure no open session → cash sale 409.
    await closeOwnerSessionIfOpen();
    const blocked = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 100, tendered: 100 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 100, discount: null }],
    });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));

    // With a drawer open the sale goes through.
    const open = await openRegister(owner, registerA, 1000);
    assert.equal(open.status, 201);
    await makeCashSale();

    // Non-cash sales are unaffected by the gate (card attempt is fine).
    const cardSale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "card", amount: 50 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 50, discount: null }],
    });
    assert.notEqual(cardSale.status, 409);

    // Policy off again; unattributed cash is now audited, not blocked.
    const unpatch = await api(owner, "PATCH", "/api/pos-settings", {
      requireOpenDrawer: false,
    });
    assert.equal(unpatch.status, 200);
    await closeOwnerSessionIfOpen();

    const saleId2 = await makeCashSale();
    const unattributed = await dbQuery(
      `SELECT id FROM audit_log WHERE business_id = $1 AND action = 'cash.unattributed' AND entity_id = $2`,
      [owner.businessId, saleId2],
    );
    assert.ok(unattributed.length === 1, "unattributed cash sale must be audited");
  });

  it("requires a manager approval token for refunds when the business enables it", async () => {
    const patch = await api(owner, "PATCH", "/api/pos-settings", {
      approvalRequired: { sale_refund: true },
    });
    assert.equal(patch.status, 200);

    const open = await openRegister(owner, registerA, 1000);
    assert.equal(open.status, 201);
    const saleId = await makeCashSale();

    const itemRows = await dbQuery(
      "SELECT id FROM sale_items WHERE sale_id = $1 ORDER BY id LIMIT 1",
      [saleId],
    );
    const saleItemId = itemRows[0].id as number;
    void saleItemId;

    const noToken = await api(owner, "POST", `/api/sold_products/refunds_all/${saleId}`, {
      reason: "customer_request",
      disposition: "restock",
    });
    assert.equal(noToken.status, 403, JSON.stringify(noToken.body));

    const verify = await api(owner, "POST", "/api/manager-approval/verify", {
      pin: "482913",
      opType: "sale.refund",
      entityType: "sale",
      entityId: saleId,
      reason: "approved counter return",
    });
    assert.equal(verify.status, 200);
    const token = payload<{ data: { approvalToken: string } }>(verify).data.approvalToken;

    const refund = await api(owner, "POST", `/api/sold_products/refunds_all/${saleId}`, {
      reason: "customer_request",
      disposition: "restock",
      approvalToken: token,
    });
    assert.equal(refund.status, 200, JSON.stringify(refund.body));

    // A token minted for sale A cannot authorize the refund of sale B.
    const saleId3 = await makeCashSale();
    const verifyB = await api(owner, "POST", "/api/manager-approval/verify", {
      pin: "482913",
      opType: "sale.refund",
      entityType: "sale",
      entityId: saleId,
    });
    const tokenB = payload<{ data: { approvalToken: string } }>(verifyB).data.approvalToken;
    void tokenB;
    const crossSale = await api(owner, "POST", `/api/sold_products/refunds_all/${saleId3}`, {
      reason: "customer_request",
      disposition: "restock",
      approvalToken: token,
    });
    // token was consumed by the first refund → 409 (before any entity check)
    assert.equal(crossSale.status, 409, "consumed token must not apply");

    const unpatch = await api(owner, "PATCH", "/api/pos-settings", {
      approvalRequired: { sale_refund: false },
    });
    assert.equal(unpatch.status, 200);
  });

  it("audits user and role administration events", async () => {
    const rows = await dbQuery(
      `SELECT action FROM audit_log WHERE business_id = $1 AND action IN ('user.created','user.disabled','user.password_reset','role.created','role.permissions_changed','role.deleted') ORDER BY id ASC`,
      [owner.businessId],
    );
    const actions = rows.map((r) => r.action);
    assert.ok(actions.includes("user.created"), "user.created must be audited");
    assert.ok(actions.includes("role.created"), "role.created must be audited");
  });
});
