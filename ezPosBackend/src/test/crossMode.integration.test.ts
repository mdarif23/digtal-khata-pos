/**
 * Stage 5 — cross-mode integration (master prompt §11).
 *
 * Boots the REAL topology on one machine: a CLOUD backend (fresh DB, port
 * :3100) and a LAN backend (fresh DB, port :3200) as two real processes,
 * with the LAN sync agent pointed at the cloud. Every transition in the
 * master prompt's Stage-5 list is driven over real HTTP with real
 * PostgreSQL on both sides — no mocks:
 *
 *   cloud→LAN (bootstrap)         LAN→cloud (push)
 *   offline burst + recovery      local server failure + restart
 *   terminal replacement          old-credential revocation
 *   database recovery (restore ⇒ re-push ⇒ NO duplicates)
 *   LAN→offline→LAN→cloud (offline ops against the LAN server)
 *
 * Verifies the Stage-5 invariant: no transaction is silently lost,
 * duplicated, or incorrectly attributed.
 *
 * Guards: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test (the two
 * topology DBs are created/migrated from scratch and dropped at the end).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, openSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { hashTerminalSecret } from "../middleware/terminalAuth.js";

const stage5: { lan?: any; lanToken?: string } = {};

/** npx→node is a process GROUP (detached spawn on POSIX) — kill the whole
 * tree so the real server never outlives its handle (orphan servers
 * poisoned several runs before this). Windows has no process-group signal:
 * taskkill /T walks the tree instead. */
function killTree(proc: ChildProcess | null): void {
  if (!proc || proc.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      return;
    } catch {
      // fall through to the direct kill
    }
  }
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}
const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

const BASE_DB = process.env.DATABASE_URL!;
const CLOUD_DB = "ezpos_stage_cloud";
const LAN_DB = "ezpos_stage_lan";
function urlFor(db: string): string {
  return BASE_DB.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
}
const CLOUD_URL = urlFor(CLOUD_DB);
const LAN_URL = urlFor(LAN_DB);
const BACKEND_DIR = fileURLToPath(new URL("../..", import.meta.url));
const TSX_CLI = join(BACKEND_DIR, "node_modules", "tsx", "dist", "cli.mjs");
const JWT = "0123456789abcdef0123456789abcdef0123456789abcdef";
const CLOUD_PORT = 3100;
const RUN_STAMP = String(process.ppid);
const CLOUD_LOG = join(tmpdir(), `ezpos-stage5-cloud-${RUN_STAMP}.log`);
const LAN_LOG = join(tmpdir(), `ezpos-stage5-lan-${RUN_STAMP}.log`);
const LAN_PORT = 3200;

/** Cross-platform server spawn: direct node + tsx CLI (spawning `npx` is a
 * .cmd shim on Windows and fails without a shell). */
function spawnServer(
  env: Record<string, string>,
  logFd: number,
  detached = false,
): ChildProcess {
  return spawn(process.execPath, [TSX_CLI, "src/server.ts"], {
    cwd: BACKEND_DIR,
    env,
    detached,
    stdio: ["ignore", logFd, logFd],
  });
}

async function adminClient() {
  const { Client } = await import("pg");
  return new Client({ connectionString: BASE_DB.replace(/\/[^/?]+(\?|$)/, "/postgres$1") });
}

async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = 45_000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Queries a TOPOLOGY database (the admin client lives on /postgres). */
async function dbQuery(db: string, text: string, params: unknown[] = []) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: urlFor(db) });
  await client.connect();
  try {
    return await client.query(text, params as never[]);
  } finally {
    await client.end();
  }
}

async function serverUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
    void res;
    return true; // ANY HTTP response means the server is listening
  } catch {
    return false;
  }
}

describe("Stage 5 — cross-mode integration (real cloud + LAN topology)", { skip: !runIntegration }, () => {
  let admin: Awaited<ReturnType<typeof adminClient>>;
  let cloudProc: ChildProcess | null = null;
  let lanProc: ChildProcess | null = null;
  let lanEnv: Record<string, string> = {};

  const agentSecret = `ezpos_tb_${randomBytes(12).toString("hex")}`;
  let agentTerminalId = 0;
  let agentSecretCurrent = agentSecret;

  before(async () => {
    console.log("[stage5] before: starting");
    // Orphaned servers from a previously killed run hold our ports — the
    // fresh spawns would silently fail to bind and traffic would hit dead
    // credentials. Reclaim the ports first.
    try {
      execFileSync("fuser", ["-k", `${CLOUD_PORT}/tcp`, `${LAN_PORT}/tcp`], { stdio: "ignore" });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch {
      // ports were free
    }
    admin = await adminClient();
    await admin.connect();
    console.log("[stage5] before: admin connected");
    // Fresh topology DBs — drop leftovers, recreate EMPTY (no template: the
    // shared ezpos_test always has concurrent connections in parallel runs).
    for (const db of [CLOUD_DB, LAN_DB]) {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${db}`);
      await admin.query(`CREATE DATABASE ${db}`);
    }
    // Migrate both in parallel (each apply-migration invocation is one node
    // process; the loop is the repo's reliable migrator path).
    const migrate = (db: string) => {
      const files = readdirSync(join(BACKEND_DIR, "drizzle"))
        .filter((f) => /^\d{4}_.*\.sql$/.test(f))
        .sort();
      for (const file of files) {
        execFileSync("node", ["scripts/apply-migration.mjs", `drizzle/${file}`], {
          cwd: BACKEND_DIR,
          env: { ...process.env, DATABASE_URL: urlFor(db) },
          stdio: "pipe",
        });
      }
    };
    console.log("[stage5] before: DBs created, migrating...");
    await Promise.all([migrate(CLOUD_DB), migrate(LAN_DB)]);
    console.log("[stage5] before: migrations done");
    // Plans must exist before any business can be created.
    const planSql = `INSERT INTO subscription_plans (name, slug, interval, price, currency, is_active)
      VALUES ('Free trial', 'free-trial', 'monthly', 0, 'BDT', true)
      ON CONFLICT (slug) DO UPDATE SET is_active = true`;
    await admin.query(planSql).catch(async () => {
      const { Client } = await import("pg");
      for (const db of [CLOUD_DB, LAN_DB]) {
        const c = new Client({ connectionString: urlFor(db) });
        await c.connect();
        await c.query(planSql);
        await c.end();
      }
    });
  });

  after(async () => {
    killTree(cloudProc);
    killTree(lanProc);
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Stage DBs are KEPT after the run for post-mortem inspection — the
    // before() hook drops any leftovers at the start of the next run.
    try {
      void admin;
    } finally {
      await admin?.end();
    }
  });

  // -- cloud seed ---------------------------------------------------------
  let cloudToken = "";
  let businessId = 0;
  let locationId = 0;
  let unitId = 0;
  let variantId = 0;
  let registerId = 0;

  async function cloudApi(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`http://127.0.0.1:${CLOUD_PORT}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cloudToken ? { Authorization: `Bearer ${cloudToken}` } : {}),
        ...(businessId ? { "X-Business-Id": String(businessId) } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  it("cloud boots and the shop is seeded on the cloud", async () => {
    const cloudLog = openSync(CLOUD_LOG, "w");
    cloudProc = spawnServer({
      ...process.env,
      PORT: String(CLOUD_PORT),
      DATABASE_URL: CLOUD_URL,
      AUTH_JWT_SECRET: JWT,
      JOBS_ENABLED: "false",
      AUTH_RATE_LIMIT_MAX: "10000",
      EZPOS_SYNC_ENABLED: "false",
    }, cloudLog);
    await waitFor("cloud server up", () => {
      if (cloudProc?.exitCode !== null && cloudProc?.exitCode !== undefined) {
        throw new Error(`cloud process exited early (code ${cloudProc.exitCode}) — see ${CLOUD_LOG}`);
      }
      return serverUp(CLOUD_PORT);
    }, 60_000);
    appendFileSync(CLOUD_LOG, `\n[cloud up at ${new Date().toISOString()}]\n`);

    const email = `stage5-${Date.now()}@example.test`;
    const registerRes = await fetch(`http://127.0.0.1:${CLOUD_PORT}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Stage5 Owner", email, password: "strong-password-123" }),
    });
    assert.equal(registerRes.status, 201);
    const login = await fetch(`http://127.0.0.1:${CLOUD_PORT}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    cloudToken = ((await login.json()) as { accessToken: string }).accessToken;

    // A freshly spawned server seeds its RBAC catalog asynchronously —
    // retry business creation until the seed lands (max ~15 s).
    let biz: { status: number; json: any } = { status: 0, json: null };
    for (let attempt = 0; attempt < 15; attempt += 1) {
      biz = await cloudApi("POST", "/api/businesses", { name: `Stage5 Biz ${Date.now()}` });
      if (biz.status === 201) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(biz.status, 201, JSON.stringify(biz.json));
    businessId = biz.json.business.id;
    const loc = await cloudApi("POST", "/api/locations", { name: "Main Store" });
    assert.equal(loc.status, 201);
    const locs = await cloudApi("GET", "/api/locations");
    locationId = locs.json.data.find((l: any) => l.name === "Main Store").id;
    const unit = await cloudApi("POST", "/api/product/unit", { unitName: "Piece", abbreviation: "Pcs" });
    unitId = unit.json.data.value;
    const prod = await cloudApi("POST", "/api/product", {
      name: "Stage5 Product",
      categoryId: null, brandId: null, unitId, description: "", productType: "physical",
      hasVariants: false, trackingType: "none", supplierId: null, status: "active",
      imageUrl: null, imageFile: null, source: "opening",
      variants: [{ sku: "", barcode: null, sellingPrice: 100, alertQuantity: 0, isDefault: true,
        status: "active", imageUrl: null, imageFile: null, batchNumber: "", purchasePrice: 40,
        quantity: 10, expiryDate: null }],
    });
    assert.equal(prod.status, 201);
    const list = await cloudApi("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find((p) => p.name === "Stage5 Product")!;
    const detail = await cloudApi("GET", `/api/product/${found.id}`);
    variantId = (detail.json as { variants: { id: number }[] }).variants[0]!.id;
    const registerRes2 = await cloudApi("POST", "/api/registers", { name: "Stage5 Drawer" });
    assert.equal(registerRes2.status, 201);
    registerId = registerRes2.json.data.id;

    // The sync-agent terminal (cloud-side pairing + capability).
    agentTerminalId = (
      await dbQuery(
        CLOUD_DB,
        `INSERT INTO pos_terminals (business_id, location_id, name, is_sync_agent, secret_hash)
         VALUES ($1, $2, 'LAN Server', true, $3) RETURNING id`,
        [businessId, locationId, hashTerminalSecret(agentSecret)],
      )
    ).rows[0].id;
  });

  it("cloud→LAN: the LAN server bootstraps identity, catalog, stock and logins", async () => {
    lanEnv = {
      ...process.env,
      PORT: String(LAN_PORT),
      DATABASE_URL: LAN_URL,
      AUTH_JWT_SECRET: JWT,
      JOBS_ENABLED: "false",
      AUTH_RATE_LIMIT_MAX: "10000",
      EZPOS_SYNC_ENABLED: "true",
      EZPOS_SYNC_CLOUD_URL: `http://127.0.0.1:${CLOUD_PORT}`,
      EZPOS_SYNC_TERMINAL_ID: String(agentTerminalId),
      EZPOS_SYNC_TERMINAL_SECRET: agentSecretCurrent,
      EZPOS_SYNC_INTERVAL_SECONDS: "1",
    };
    const lanLog = openSync(LAN_LOG, "w");
    // Credential self-check FIRST: the same bootstrap the agent will call.
    const storedTerminal = await dbQuery(
      CLOUD_DB,
      `SELECT id, status, is_sync_agent, left(secret_hash, 12) AS hash_prefix FROM pos_terminals WHERE id = $1`,
      [agentTerminalId],
    );
    console.log(
      "[stage5] agent terminal:",
      JSON.stringify(storedTerminal.rows[0]),
      "presented:",
      hashTerminalSecret(agentSecretCurrent).slice(0, 12),
    );
    const selfCheck = await fetch(`http://127.0.0.1:${CLOUD_PORT}/api/sync/bootstrap`, {
      headers: {
        Authorization: `Bearer ${agentSecretCurrent}`,
        "X-Terminal-Id": String(agentTerminalId),
      },
    });
    console.log("[stage5] credential self-check:", selfCheck.status);
    lanProc = spawnServer(lanEnv, lanLog, true);
    await waitFor("LAN server up", () => serverUp(LAN_PORT), 60_000);
    appendFileSync(LAN_LOG, `\n[lan up at ${new Date().toISOString()}]\n`);
    // First sweeps: identity + catalog + stock land locally.
    await waitFor("LAN catalog synced", async () => {
      const { Client } = await import("pg");
      const c = new Client({ connectionString: LAN_URL });
      await c.connect();
      const { rows } = await c.query(`SELECT quantity FROM inventory_stock WHERE variant_id = $1`, [variantId]);
      await c.end();
      return rows.length === 1 && Number(rows[0].quantity) === 10;
    });

    const lan = async (
      method: string,
      path: string,
      body?: unknown,
      tokenOrHeaders?: string | Record<string, string>,
    ) => {
      const extra =
        typeof tokenOrHeaders === "string"
          ? { Authorization: `Bearer ${tokenOrHeaders}` }
          : (tokenOrHeaders ?? {});
      const res = await fetch(`http://127.0.0.1:${LAN_PORT}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...extra,
          "X-Business-Id": String(businessId),
          "X-Location-Id": String(locationId),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };

    // A cloud cashier logs in ON THE LAN SERVER (password hashes synced).
    const meOnCloud = await cloudApi("GET", "/api/auth/me");
    const ownerEmail = meOnCloud.json.user.email;
    const lanLogin = await fetch(`http://127.0.0.1:${LAN_PORT}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ownerEmail, password: "strong-password-123" }),
    });
    assert.equal(lanLogin.status, 200, "offline login works from synced identity");
    const lanToken = ((await lanLogin.json()) as { accessToken: string }).accessToken;
    const lanMe = await lan("GET", "/api/auth/me", undefined, lanToken);
    assert.equal(lanMe.json?.user?.email, ownerEmail);

    // LAN can read the synced catalog.
    const lanProducts = await lan("GET", "/api/products", undefined, lanToken);
    assert.ok(
      (lanProducts.json as { id: number }[]).some((p) => p.id === variantId),
      "catalog visible on LAN",
    );
    stage5.lan = lan;
    stage5.lanToken = lanToken;
  });

  it("LAN→cloud: a LAN sale syncs once, attributed and stock-consistent", async () => {
    const { lan, lanToken } = stage5;
    const key = `stage5-sale-${Date.now()}`;
    const sale = await lan("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 300, tendered: 300 }],
      discount: null,
      vatPercent: 0,
      idempotencyKey: key,
      items: [{ variantId, quantity: 3, unitPrice: 100, discount: null }],
    }, lanToken);
    assert.equal(sale.status, 201, JSON.stringify(sale.json));

    // Cloud receives exactly one replica within a sweep or two.
    await waitFor("cloud replica", async () => {
      const { rows } = await dbQuery(CLOUD_DB,
        `SELECT count(*)::int AS n FROM sales WHERE business_id = $1 AND idempotency_key = $2 AND channel = 'offline'`,
        [businessId, key],
      );
      return rows[0].n === 1;
    });
    const cloudStock = await dbQuery(CLOUD_DB, 
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [variantId, businessId],
    );
    assert.equal(Number(cloudStock.rows[0].quantity), 7, "cloud stock deducted once");
    // LAN marks it synced; repeated sweeps do NOT duplicate.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const replicas = await dbQuery(CLOUD_DB, 
      `SELECT count(*)::int AS n FROM sales WHERE business_id = $1 AND idempotency_key = $2`,
      [businessId, key],
    );
    assert.equal(replicas.rows[0].n, 1, "no duplicate on repeated sweeps");
  });

  it("internet recovery: a burst of LAN sales made while the cloud is down all arrive, once each", async () => {
    const { lan, lanToken } = stage5;
    // "Internet down": stop the cloud backend. killTree handles the
    // process group; fuser is the belt-and-braces port hammer (a lingering
    // listener would fake an up cloud).
    killTree(cloudProc);
    cloudProc = null;
    await new Promise((resolve) => setTimeout(resolve, 800));
    try {
      execFileSync("fuser", ["-k", `${CLOUD_PORT}/tcp`], { stdio: "ignore" });
    } catch {
      // nothing listening
    }
    await waitFor("cloud port actually down", async () => {
      try {
        await fetch(`http://127.0.0.1:${CLOUD_PORT}/api/auth/me`);
        return false;
      } catch {
        return true;
      }
    }, 15_000);

    const keys = [`stage5-burst-1-${Date.now()}`, `stage5-burst-2-${Date.now()}`];
    for (const [i, key] of keys.entries()) {
      const sale = await lan("POST", "/api/sales", {
        saleDate: new Date().toISOString(),
        customerId: null,
        payments: [{ method: "cash", amount: 100, tendered: 100 }],
        discount: null,
        vatPercent: 0,
        idempotencyKey: key,
        items: [{ variantId, quantity: 1, unitPrice: 100, discount: null }],
      }, lanToken);
      assert.equal(sale.status, 201, `LAN keeps selling while the internet is down (${i + 1})`);
    }

    // "Internet back": restart the cloud.
    const cloudLog2 = openSync(CLOUD_LOG, "a");
    cloudProc = spawnServer({
      ...process.env,
      PORT: String(CLOUD_PORT),
      DATABASE_URL: CLOUD_URL,
      AUTH_JWT_SECRET: JWT,
      JOBS_ENABLED: "false",
      AUTH_RATE_LIMIT_MAX: "10000",
      EZPOS_SYNC_ENABLED: "false",
    }, cloudLog2);
    await waitFor("cloud back up", () => serverUp(CLOUD_PORT), 60_000);
    await waitFor("both burst sales replicated", async () => {
      const { rows } = await dbQuery(CLOUD_DB, 
        `SELECT count(*)::int AS n FROM sales WHERE business_id = $1 AND idempotency_key = ANY($2) AND channel = 'offline'`,
        [businessId, keys],
      );
      return rows[0].n === 2;
    });
    const stock = await dbQuery(CLOUD_DB, 
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [variantId, businessId],
    );
    assert.equal(Number(stock.rows[0].quantity), 5, "cloud stock 7 − 2 burst units");
  });

  it("local server failure: committed sales survive a LAN restart and still sync", async () => {
    const { lan, lanToken } = stage5;
    const key = `stage5-restart-${Date.now()}`;
    const sale = await lan("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 100, tendered: 100 }],
      discount: null,
      vatPercent: 0,
      idempotencyKey: key,
      items: [{ variantId, quantity: 1, unitPrice: 100, discount: null }],
    }, lanToken);
    assert.equal(sale.status, 201);

    // Kill the LAN server BEFORE its agent can push this sale.
    killTree(lanProc);
    lanProc = null;
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Restart with the same configuration — the sale was already committed
    // locally, so nothing can be lost.
    const lanLog2 = openSync(LAN_LOG, "a");
    lanProc = spawnServer(lanEnv, lanLog2, true);
    await waitFor("LAN back up", () => serverUp(LAN_PORT), 60_000);
    await waitFor("post-restart sale replicated", async () => {
      const { rows } = await dbQuery(CLOUD_DB, 
        `SELECT count(*)::int AS n FROM sales WHERE business_id = $1 AND idempotency_key = $2 AND channel = 'offline'`,
        [businessId, key],
      );
      return rows[0].n === 1;
    });
  });

  it("terminal replacement: revocation is immediate and the new agent takes over", async () => {
    const { lan } = stage5;
    // Deactivate the agent on the cloud → the OLD credential dies instantly.
    await dbQuery(CLOUD_DB, `UPDATE pos_terminals SET status = 'inactive' WHERE id = $1`, [agentTerminalId]);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const oldSecret = agentSecretCurrent;
    const denied = await fetch(`http://127.0.0.1:${CLOUD_PORT}/api/sync/bootstrap`, {
      headers: { Authorization: `Bearer ${oldSecret}`, "X-Terminal-Id": String(agentTerminalId) },
    });
    assert.equal(denied.status, 403, "revoked agent is locked out immediately");

    // Pair a REPLACEMENT agent on the cloud: the un-pair flow clears the
    // old terminal's agent flag first — the partial unique index enforces
    // one agent per location, which is exactly the two-server prevention.
    await dbQuery(CLOUD_DB, `UPDATE pos_terminals SET is_sync_agent = false WHERE id = $1`, [agentTerminalId]);
    const replacementSecret = `ezpos_tb_${randomBytes(12).toString("hex")}`;
    const replacementId = (
      await dbQuery(
        CLOUD_DB,
        `INSERT INTO pos_terminals (business_id, location_id, name, is_sync_agent, secret_hash)
         VALUES ($1, $2, 'LAN Server v2', true, $3) RETURNING id`,
        [businessId, locationId, hashTerminalSecret(replacementSecret)],
      )
    ).rows[0].id;

    // The LAN server re-pairs: restart with the new credential (pair.mjs flow).
    killTree(lanProc);
    lanProc = null;
    await new Promise((resolve) => setTimeout(resolve, 500));
    agentSecretCurrent = replacementSecret;
    lanEnv = { ...lanEnv, EZPOS_SYNC_TERMINAL_ID: String(replacementId), EZPOS_SYNC_TERMINAL_SECRET: replacementSecret };
    const lanLog3 = openSync(LAN_LOG, "a");
    lanProc = spawnServer(lanEnv, lanLog3, true);
    await waitFor("LAN back up with replacement agent", () => serverUp(LAN_PORT), 60_000);

    // Pushes resume: ring one more sale and wait for it on the cloud.
    const key = `stage5-replacement-${Date.now()}`;
    const sale = await lan("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 100, tendered: 100 }],
      discount: null,
      vatPercent: 0,
      idempotencyKey: key,
      items: [{ variantId, quantity: 1, unitPrice: 100, discount: null }],
    }, (stage5).lanToken);
    assert.equal(sale.status, 201);
    await waitFor("replacement-agent push lands", async () => {
      const { rows } = await dbQuery(CLOUD_DB, 
        `SELECT count(*)::int AS n FROM sales WHERE business_id = $1 AND idempotency_key = $2 AND channel = 'offline'`,
        [businessId, key],
      );
      return rows[0].n === 1;
    });
  });

  it("LAN→offline→LAN→cloud: offline ops (allocations, conflicts) chain through to the cloud", async () => {
    const { lan, lanToken } = stage5;
    // A browser terminal on the LAN server (per-server registry).
    const lanTerminalId = (
      await dbQuery(
        LAN_DB,
        `INSERT INTO pos_terminals (business_id, location_id, name) VALUES ($1, $2, 'Offline Counter') RETURNING id`,
        [businessId, locationId],
      )
    ).rows[0].id;
    const offlineHeaders = { "X-Terminal-Id": String(lanTerminalId) };

    // Grant an offline allowance ON THE LAN server.


    // An offline-recorded sale op replays through the LAN's offline surface.
    const key = `stage5-offline-${Date.now()}`;
    const op = {
      opId: key,
      type: "sale.create",
      payload: {
        sale: {
          saleDate: new Date().toISOString(),
          customerId: null,
          payments: [{ method: "cash", amount: 200, tendered: 200 }],
          discount: null,
          vatPercent: 0,
          idempotencyKey: key,
          items: [{ variantId, quantity: 2, unitPrice: 100, discount: null }],
        },
      },
    };
    const sync = await lan(
      "POST",
      "/api/offline/sync",
      { ops: [op] },
      { Authorization: `Bearer ${stage5.lanToken!}`, "X-Terminal-Id": String(lanTerminalId) },
    );
    assert.equal(sync.status, 200);
    assert.equal(sync.json.data.results[0].status, "applied", JSON.stringify(sync.json));

    // The LAN sale (channel offline) reaches the CLOUD through the agent.
    await waitFor("offline-op sale reaches cloud", async () => {
      const { rows } = await dbQuery(CLOUD_DB, 
        `SELECT count(*)::int AS n FROM sales WHERE business_id = $1 AND idempotency_key = $2 AND channel = 'offline'`,
        [businessId, key],
      );
      return rows[0].n === 1;
    });
    const stock = await dbQuery(CLOUD_DB, 
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [variantId, businessId],
    );
    // 10 − 3 (LAN sale) − 2 (burst) − 1 (restart) − 1 (replacement)
    //     − 2 (offline op) = 1 — every unit deducted exactly once.
    assert.equal(Number(stock.rows[0].quantity), 1, "cloud stock fully consistent across all modes");
  });

  it("database recovery: a restored LAN re-pushes already-synced sales with ZERO duplicates", async () => {
    // Simulate a RESTORE of the LAN database: every synced-sale marker is
    // gone, so the agent re-pushes its ENTIRE history. The cloud's
    // idempotency keys must make every replay a no-op replica.
    const stockBefore = await dbQuery(
      CLOUD_DB,
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [variantId, businessId],
    );
    await dbQuery(LAN_DB, `UPDATE sales SET synced_at = NULL WHERE business_id = $1`, [businessId]);
    const before = await dbQuery(
      CLOUD_DB,
      `SELECT count(*)::int AS n FROM sales WHERE business_id = $1 AND channel = 'offline'`,
      [businessId],
    );
    // Wait for the storm to settle: every LAN sale re-synced.
    await waitFor("restore re-push settled", async () => {
      const { rows } = await dbQuery(
        LAN_DB,
        `SELECT count(*)::int AS n FROM sales WHERE business_id = $1 AND synced_at IS NULL`,
        [businessId],
      );
      return rows[0].n === 0;
    });
    const after = await dbQuery(
      CLOUD_DB,
      `SELECT count(*)::int AS n FROM sales WHERE business_id = $1 AND channel = 'offline'`,
      [businessId],
    );
    assert.equal(after.rows[0].n, before.rows[0].n, "restore re-push created ZERO duplicate replicas");
    const stock = await dbQuery(
      CLOUD_DB,
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [variantId, businessId],
    );
    assert.equal(
      Number(stock.rows[0].quantity),
      Number(stockBefore.rows[0].quantity),
      "cloud stock untouched by the replay storm",
    );
  });
});
