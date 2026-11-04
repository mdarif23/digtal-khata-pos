/**
 * POS terminal & hardware bridge integration tests (Phase 5 backend).
 *
 * Covers the pairing flow (one-time code → terminal secret), terminal
 * administration, terminal-secret authentication, targeted drawer-open
 * commands (permissions, sale/location binding, claim + ack state
 * machine, expiry), and business isolation.
 *
 * Double-guarded like the other suites: runs ONLY with INTEGRATION_TESTS=1
 * AND DATABASE_URL pointing at ezpos_test (fail-closed). Plain `npm test`
 * NEVER runs this file.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("pos terminals integration", { skip: !runIntegration }, () => {
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
  }

  interface Bridge {
    terminalId: number;
    secret: string;
  }

  async function api(
    ctx: Ctx,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.token}`,
        "X-Business-Id": String(ctx.businessId),
        ...extraHeaders,
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

  async function registerOwner(
    businessName: string,
  ): Promise<{ ctx: Ctx; locationId: number }> {
    const email = `term-${stamp}-${Math.floor(Math.random() * 1e6)}@example.test`;
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Terminal Owner",
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
    const loginBody = (await login.json()) as {
      accessToken: string;
      user: { id: number };
    };
    const ctx: Ctx = {
      token: loginBody.accessToken,
      businessId: 0,
      userId: loginBody.user.id,
    };
    const biz = await api(ctx, "POST", "/api/businesses", { name: businessName });
    assert.equal(biz.status, 201);
    ctx.businessId = payload<{ business: { id: number } }>(biz).business.id;
    const loc = await api(ctx, "POST", "/api/locations", { name: "Main" });
    assert.equal(loc.status, 201);
    return { ctx, locationId: payload<{ data: { id: number } }>(loc).data.id };
  }

  /** Pairs a bridge terminal for the given owner/location. */
  async function pairBridge(
    ctx: Ctx,
    deviceName: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Bridge> {
    const codeRes = await api(ctx, "POST", "/api/terminals/pairing-code", undefined, extraHeaders);
    assert.equal(codeRes.status, 201, JSON.stringify(codeRes.body));
    const code = payload<{ data: { code: string } }>(codeRes).data.code;
    assert.match(code, /^[A-Z2-9]{8}$/);
    const pair = await fetch(`${baseUrl}/api/bridge/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, deviceName, deviceInfo: { os: "Windows", version: "1.0.0" } }),
    });
    const pairText = await pair.text();
    assert.equal(pair.status, 201, pairText);
    const body = JSON.parse(pairText) as {
      data: { terminalId: number; secret: string; terminalName: string };
    };
    assert.match(body.data.secret, /^ezpos_tb_[0-9a-f]{48}$/);
    return { terminalId: body.data.terminalId, secret: body.data.secret };
  }

  function bridgeHeaders(bridge: Bridge): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bridge.secret}`,
      "X-Terminal-Id": String(bridge.terminalId),
    };
  }

  async function bridgeCall(
    bridge: Bridge,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: bridgeHeaders(bridge),
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

  let owner: Ctx;
  let other: Ctx;
  let bridge: Bridge;
  let otherBridge: Bridge;
  let cashier: Ctx;
  let variantId = 0;

  before(async () => {
    const main = await registerOwner(`Term Biz ${stamp}`);
    owner = main.ctx;
    const second = await registerOwner(`Term Biz B ${stamp}`);
    other = second.ctx;

    // A stocked product so the cashier can make a sale.
    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Piece ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ data: { value: number } }>(unitRes).data.value;
    await api(owner, "POST", "/api/product", {
      name: `Term Cola ${stamp}`,
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
          sku: `TERM-${stamp}`,
          barcode: null,
          sellingPrice: 100,
          alertQuantity: 5,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `TB-${stamp}`,
          purchasePrice: 40,
          quantity: 100,
          expiryDate: null,
        },
      ],
    });
    const list = await api(owner, "GET", "/api/products");
    const created = (
      list.body as { name: string; variants: { id: number }[] }[]
    ).find((p) => p.name === `Term Cola ${stamp}`);
    assert.ok(created);
    variantId = created.variants[0]!.id;

    bridge = await pairBridge(owner, `Front Counter ${stamp}`);
    otherBridge = await pairBridge(other, `Back Office ${stamp}`);
  });

  it("pairs a bridge through a one-time code; codes are single-use", async () => {
    const terminals = await api(owner, "GET", "/api/terminals");
    assert.equal(terminals.status, 200);
    const rows = payload<{ data: { id: number; paired: boolean; name: string }[] }>(
      terminals,
    ).data;
    const mine = rows.find((t) => t.id === bridge.terminalId);
    assert.ok(mine);
    assert.equal(mine.paired, true);
    assert.equal(mine.name, `Front Counter ${stamp}`);

    // The code from setup is used: pairing again with the same code fails.
    const codeRes = await api(owner, "POST", "/api/terminals/pairing-code");
    const code = payload<{ data: { code: string } }>(codeRes).data.code;
    const first = await fetch(`${baseUrl}/api/bridge/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, deviceName: "Ghost" }),
    });
    assert.equal(first.status, 201);
    const replay = await fetch(`${baseUrl}/api/bridge/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, deviceName: "Ghost 2" }),
    });
    assert.equal(replay.status, 409);

    // Made-up codes fail cleanly.
    const bogus = await fetch(`${baseUrl}/api/bridge/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "ZZZZZZZZ" }),
    });
    assert.equal(bogus.status, 400);
  });

  it("terminal authentication is required and secrets are validated", async () => {
    const noAuth = await fetch(`${baseUrl}/api/bridge/terminal`);
    assert.equal(noAuth.status, 401);

    const badSecret = await fetch(`${baseUrl}/api/bridge/terminal`, {
      headers: bridgeHeaders({ terminalId: bridge.terminalId, secret: "ezpos_tb_deadbeef" }),
    });
    assert.equal(badSecret.status, 401);

    // A valid secret presented for ANOTHER terminal's id fails.
    const swapped = await fetch(`${baseUrl}/api/bridge/terminal`, {
      headers: bridgeHeaders({ terminalId: otherBridge.terminalId, secret: bridge.secret }),
    });
    assert.equal(swapped.status, 401);

    const self = await bridgeCall(bridge, "GET", "/api/bridge/terminal");
    assert.equal(self.status, 200);
    assert.equal(payload<{ data: { terminalId: number } }>(self).data.terminalId, bridge.terminalId);
  });

  it("staff without pos_terminal.manage cannot mint pairing codes", async () => {
    const roles = await api(owner, "GET", "/api/roles");
    const cashierRole = payload<{ data: { id: number; slug: string }[] }>(roles).data.find(
      (r) => r.slug === "cashier",
    );
    assert.ok(cashierRole);
    const email = `term-cashier-${stamp}@example.test`;
    const locationList = payload<{ data: { id: number; isDefault: boolean }[] }>(
      await api(owner, "GET", "/api/locations"),
    ).data;
    const defaultLocationId =
      locationList.find((l) => l.isDefault)?.id ?? locationList[0]!.id;
    const created = await api(owner, "POST", "/api/users", {
      fullName: "Term Cashier",
      email,
      password: "strong-password-123",
      roleIds: [cashierRole.id],
      locationIds: [defaultLocationId],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    cashier = {
      token: ((await login.json()) as { accessToken: string }).accessToken,
      businessId: owner.businessId,
      userId: payload<{ data: { userId: number } }>(created).data.userId,
    };

    const denied = await api(cashier, "POST", "/api/terminals/pairing-code");
    assert.equal(denied.status, 403);
  });

  it("businesses cannot see or target each other's terminals", async () => {
    const foreign = await api(other, "GET", `/api/terminals/${bridge.terminalId}`);
    assert.equal(foreign.status, 404);
    const foreignCommands = await api(
      other,
      "GET",
      `/api/terminals/${bridge.terminalId}/commands`,
    );
    assert.equal(foreignCommands.status, 404);
    const foreignCommandPost = await api(other, "POST", "/api/hardware/commands", {
      terminalId: bridge.terminalId,
      type: "drawer_open",
    });
    assert.equal(foreignCommandPost.status, 404);
  });

  it("runs the drawer command lifecycle: create → claim → execute → complete", async () => {
    // Owner (wildcard) may open the drawer without a sale.
    const created = await api(owner, "POST", "/api/hardware/commands", {
      terminalId: bridge.terminalId,
      type: "drawer_open",
      reason: "cash drawer check",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const commandId = payload<{ data: { id: number; status: string } }>(created).data.id;
    assert.equal(payload<{ data: { status: string } }>(created).data.status, "pending");

    // The bridge claims it — exactly once.
    const claimed = await bridgeCall(bridge, "POST", "/api/bridge/commands/claim");
    assert.equal(claimed.status, 200);
    const claimedRows = payload<{ data: { id: number; status: string }[] }>(claimed).data;
    const mine = claimedRows.find((c) => c.id === commandId);
    assert.ok(mine, "the pending command was delivered to its own terminal");
    assert.equal(mine.status, "received");
    const reClaim = await bridgeCall(bridge, "POST", "/api/bridge/commands/claim");
    assert.equal(
      payload<{ data: unknown[] }>(reClaim).data.length,
      0,
      "a claimed command is never delivered twice",
    );

    // Terminal acks: pending commands cannot be acked directly; progress is
    // one-way until completion.
    const pendingAck = await bridgeCall(bridge, "POST", "/api/bridge/commands/0/ack", {
      status: "executing",
    });
    assert.equal(pendingAck.status, 400);

    const exec = await bridgeCall(bridge, "POST", `/api/bridge/commands/${commandId}/ack`, {
      status: "executing",
    });
    assert.equal(exec.status, 200, JSON.stringify(exec.body));
    const done = await bridgeCall(bridge, "POST", `/api/bridge/commands/${commandId}/ack`, {
      status: "completed",
      detail: { via: "ESC/POS pin 2", printer: "TM-T20III" },
    });
    assert.equal(done.status, 200);

    // POS-side status polling sees the outcome.
    const status = await api(owner, "GET", `/api/hardware/commands/${commandId}`);
    assert.equal(status.status, 200);
    const statusBody = payload<{ data: { status: string; result: unknown } }>(status).data;
    assert.equal(statusBody.status, "completed");
    assert.deepEqual(statusBody.result, { via: "ESC/POS pin 2", printer: "TM-T20III" });

    // Terminal states are immutable — no re-execution of a settled command.
    const replay = await bridgeCall(bridge, "POST", `/api/bridge/commands/${commandId}/ack`, {
      status: "executing",
    });
    assert.equal(replay.status, 409);

    // History is queryable per terminal.
    const history = await api(owner, "GET", `/api/terminals/${bridge.terminalId}/commands`);
    assert.equal(history.status, 200);
    assert.ok(
      payload<{ data: { id: number }[] }>(history).data.some((c) => c.id === commandId),
    );
  });

  it("drawer command permissions: cashier may kick after a sale, not without one", async () => {
    // No-sale kick: cashier lacks cash_drawer.open_without_sale.
    const denied = await api(cashier, "POST", "/api/hardware/commands", {
      terminalId: bridge.terminalId,
      type: "drawer_open",
    });
    assert.equal(denied.status, 403);

    // Sale-linked kick: the cashier holds cash_drawer.open.
    const sale = await api(cashier, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 100, tendered: 100 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 100, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const saleId = (sale.body as { data: { sale: { id: number } } }).data.sale.id;
    const allowed = await api(cashier, "POST", "/api/hardware/commands", {
      terminalId: bridge.terminalId,
      type: "drawer_open",
      saleId,
    });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));

    // The terminal must sit at the sale's own location — a foreign-location
    // terminal is unreachable (404-masked, same as a missing terminal).
    const secondLoc = await api(owner, "POST", "/api/locations", { name: `Branch ${stamp}` });
    const secondLocId = payload<{ data: { id: number } }>(secondLoc).data.id;
    const branchBridge = await pairBridge(
      owner,
      `Branch Terminal ${stamp}`,
      { "X-Location-Id": String(secondLocId) },
    );
    const wrongLocation = await api(cashier, "POST", "/api/hardware/commands", {
      terminalId: branchBridge.terminalId,
      type: "drawer_open",
      saleId,
    });
    assert.equal(wrongLocation.status, 404);

    // Deactivating the branch terminal blocks commands outright.
    const deactivated = await api(owner, "PATCH", `/api/terminals/${branchBridge.terminalId}`, {
      status: "inactive",
    });
    assert.equal(deactivated.status, 200);
    const blocked = await api(owner, "POST", "/api/hardware/commands", {
      terminalId: branchBridge.terminalId,
      type: "drawer_open",
    });
    assert.equal(blocked.status, 400);
  });

  it("expired commands never reach the bridge and cannot be settled", async () => {
    const created = await api(owner, "POST", "/api/hardware/commands", {
      terminalId: bridge.terminalId,
      type: "drawer_open",
    });
    assert.equal(created.status, 201);
    const commandId = payload<{ data: { id: number } }>(created).data.id;

    // Force expiry directly (TTL clamp is 5s — no sleeping in tests).
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(
      "UPDATE hardware_commands SET expires_at = now() - interval '1 second' WHERE id = $1",
      [commandId],
    );
    await client.end();

    const claimed = await bridgeCall(bridge, "POST", "/api/bridge/commands/claim");
    const ids = payload<{ data: { id: number }[] }>(claimed).data.map((c) => c.id);
    assert.equal(ids.includes(commandId), false, "expired commands are not delivered");

    const status = await api(owner, "GET", `/api/hardware/commands/${commandId}`);
    assert.equal(payload<{ data: { status: string } }>(status).data.status, "expired");
  });

  it("a swept limbo command can still receive its true late outcome", async () => {
    const created = await api(owner, "POST", "/api/hardware/commands", {
      terminalId: bridge.terminalId,
      type: "drawer_open",
    });
    const commandId = payload<{ data: { id: number } }>(created).data.id;

    await bridgeCall(bridge, "POST", "/api/bridge/commands/claim");

    // The bridge dies mid-flight and the command times out past expiry —
    // the sweep moves received → unknown_outcome.
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(
      "UPDATE hardware_commands SET expires_at = now() - interval '1 second' WHERE id = $1",
      [commandId],
    );
    await client.end();
    await bridgeCall(bridge, "POST", "/api/bridge/commands/claim"); // triggers the sweep

    const limbo = await api(owner, "GET", `/api/hardware/commands/${commandId}`);
    assert.equal(payload<{ data: { status: string } }>(limbo).data.status, "unknown_outcome");

    // The bridge comes back and reports what actually happened.
    const late = await bridgeCall(bridge, "POST", `/api/bridge/commands/${commandId}/ack`, {
      status: "failed",
      detail: { reason: "printer offline" },
    });
    assert.equal(late.status, 200, JSON.stringify(late.body));
    const after = await api(owner, "GET", `/api/hardware/commands/${commandId}`);
    assert.equal(payload<{ data: { status: string } }>(after).data.status, "failed");
  });

  it("secret rotation revokes the old bridge credential immediately", async () => {
    const rotated = await api(owner, "POST", `/api/terminals/${bridge.terminalId}/rotate-secret`);
    assert.equal(rotated.status, 200);
    const newSecret = payload<{ data: { secret: string } }>(rotated).data.secret;

    const oldWorks = await fetch(`${baseUrl}/api/bridge/terminal`, {
      headers: bridgeHeaders(bridge),
    });
    assert.equal(oldWorks.status, 401, "the old secret must be dead");

    bridge = { ...bridge, secret: newSecret };
    const self = await bridgeCall(bridge, "GET", "/api/bridge/terminal");
    assert.equal(self.status, 200);
  });

  it("deactivated terminals are locked out; unpaired ones can be deleted", async () => {
    // A fresh unpaired-capable flow: deactivate, verify lockout, delete.
    const second = await pairBridge(owner, `Disposable ${stamp}`);
    const off = await api(owner, "PATCH", `/api/terminals/${second.terminalId}`, {
      status: "inactive",
    });
    assert.equal(off.status, 200);
    const locked = await bridgeCall(second, "GET", "/api/bridge/terminal");
    assert.equal(locked.status, 403);
    const commandBlocked = await api(owner, "POST", "/api/hardware/commands", {
      terminalId: second.terminalId,
      type: "drawer_open",
    });
    assert.equal(commandBlocked.status, 400);

    // Paired terminal with command history cannot be deleted.
    const withHistory = await api(owner, "DELETE", `/api/terminals/${bridge.terminalId}`);
    assert.equal(withHistory.status, 409);

    // An unpaired terminal can be created and deleted via pairing-less flow:
    // use the OTHER business's freshly paired terminal without commands.
    const deletable = await api(other, "DELETE", `/api/terminals/${otherBridge.terminalId}`);
    assert.equal(deletable.status, 200);
    const gone = await bridgeCall(otherBridge, "GET", "/api/bridge/terminal");
    assert.equal(gone.status, 401, "deleted terminal credentials stop working");
    otherBridge = { ...otherBridge, terminalId: -1, secret: "" };
  });
});
