#!/usr/bin/env node
/**
 * END-TO-END chain check (Phase 5): real ezPos backend + real bridge
 * client + real command loop + a mock printer (TCP server that accepts
 * the drawer-kick bytes).
 *
 * Chain under test:
 *   POS request → backend authz → hardware_commands row → bridge claim
 *   → raw TCP kick → ack completed → POS status poll → audit rows
 *
 * Requires: ezpos_test database reachable (DATABASE_URL), Node 22.
 * Run from ezPosHardwareBridge/:  npm run e2e
 */
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const BACKEND_ROOT = new URL("../../ezPosBackend/", import.meta.url).pathname;
// `pg` belongs to the backend package — resolve it from there.
const backendRequire = createRequire(`${BACKEND_ROOT}package.json`);

// Isolate bridge state so the developer's real pairing is untouched.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ezpos-e2e-"));
process.env.EZPOS_BRIDGE_DATA_DIR = sandbox;
// Backend env for its own config (CI-style values; the e2e backend only
// mints short-lived access tokens for this run).
process.env.AUTH_RATE_LIMIT_MAX = "10000";
process.env.AUTH_JWT_SECRET ??= "e2e-only-secret-not-used-in-production-0123456789";

const { buildApp } = await import(`${BACKEND_ROOT}src/app.js`);
const { ensureRbacSeed } = await import(`${BACKEND_ROOT}src/rbac/seed.js`);
const { pairTerminal } = await import("../src/services/bridgeClient.js");
const { saveConfig, saveCredentials, loadConfig } = await import("../src/config/config.js");
const { runOnce } = await import("../src/services/commandLoop.js");

const stamp = Date.now();
const receivedChunks: Buffer[] = [];
let printerSockets = 0;

// --- mock printer: accepts bytes, holds the socket briefly, closes ---
const printer = net.createServer((socket) => {
  printerSockets += 1;
  socket.on("data", (chunk) => receivedChunks.push(Buffer.from(chunk)));
  socket.on("error", () => undefined);
});
await new Promise<void>((resolve) => printer.listen(0, "127.0.0.1", resolve));
const printerPort = (printer.address() as { port: number }).port;

// --- real backend ---
await ensureRbacSeed();
const app = buildApp();
const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const json = async (res: Response) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const req = async (
  method: string,
  apiPath: string,
  headers: Record<string, string>,
  body?: unknown,
) => {
  const res = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await json(res) };
};

const H = { "Content-Type": "application/json" };
let fail = 0;
const step = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✔" : "✖"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fail += 1;
};

try {
  // 1. Owner + business + location (backend registration → login → business).
  const email = `e2e-bridge-${stamp}@example.test`;
  const reg = await req("POST", "/api/auth/register", H, {
    fullName: "E2E Bridge Owner",
    email,
    password: "strong-password-123",
  });
  step("backend: register owner", reg.status === 201);
  const login = await req("POST", "/api/auth/login", H, {
    email,
    password: "strong-password-123",
  });
  const token = (login.body as { accessToken: string }).accessToken;
  const biz = await req("POST", "/api/businesses", { ...H, Authorization: `Bearer ${token}` }, {
    name: `E2E Bridge Biz ${stamp}`,
  });
  const businessId = (biz.body as { business: { id: number } }).business.id;
  const A = { ...H, Authorization: `Bearer ${token}`, "X-Business-Id": String(businessId) };
  const loc = await req("POST", "/api/locations", A, { name: "E2E Store" });
  const locationId = (loc.body as { data: { id: number } }).data.id;
  step("backend: business + location", biz.status === 201 && loc.status === 201);

  // Trial plan for requireFullAccess on the command endpoint.
  const pg = backendRequire("pg");
  const dbClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await dbClient.connect();
  await dbClient.query(
    `INSERT INTO subscription_plans (name, slug, interval, price, currency, is_active)
     VALUES ('Free trial', 'free-trial', 'monthly', 0, 'BDT', true)
     ON CONFLICT (slug) DO UPDATE SET limits = NULL, is_active = true`,
  );
  await dbClient.end();

  // 2. Pairing code (POS UI path) → bridge pair (real bridge client).
  const codeRes = await req("POST", "/api/terminals/pairing-code", A);
  const code = (codeRes.body as { data: { code: string } }).data.code;
  step("backend: pairing code minted", codeRes.status === 201 && /^[A-Z2-9]{8}$/.test(code));

  const pair = await pairTerminal(baseUrl, code, `E2E Terminal ${stamp}`, {
    os: "linux (e2e)",
    node: process.version,
  });
  step("bridge: paired, secret received once", /^ezpos_tb_[0-9a-f]{48}$/.test(pair.secret));
  saveCredentials({
    terminalId: pair.terminalId,
    secret: pair.secret,
    terminalName: pair.terminalName,
    locationId: pair.locationId,
    pairedAt: new Date().toISOString(),
  });
  saveConfig({
    backendUrl: baseUrl,
    pollIntervalMs: 1000,
    printers: [
      { name: "Mock printer", kind: "rawTcp", host: "127.0.0.1", port: printerPort, pin: 2, onMs: 50, offMs: 500 },
    ],
  });
  step("bridge: config + credentials stored", loadConfig().printers.length === 1);

  // 3. POS authors a drawer command (no-sale → open_without_sale).
  const commandRes = await req("POST", "/api/hardware/commands", A, {
    terminalId: pair.terminalId,
    type: "drawer_open",
    reason: "e2e chain check",
  });
  step("POS: drawer command authorized", commandRes.status === 201);
  const commandId = (commandRes.body as { data: { id: number } }).data.id;

  // 4. The bridge runs one claim/execute/ack cycle for real.
  const config = loadConfig();
  const handled = await runOnce(config, {
    terminalId: pair.terminalId,
    secret: pair.secret,
    terminalName: pair.terminalName,
    locationId: pair.locationId,
    pairedAt: new Date().toISOString(),
  }, {
    log: (message) => console.log(`  [bridge] ${message}`),
    onError: (message) => console.error(`  [bridge] ${message}`),
  });
  step("bridge: claimed and executed the command", handled === 1);

  // 5. The mock printer received the exact ESC p bytes.
  const bytes = Buffer.concat(receivedChunks);
  const expected = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  step("printer: received ESC p pin2 50ms/500ms", bytes.equals(expected), bytes.toString("hex"));

  // 6. POS polls the command outcome.
  const status = await req("GET", `/api/hardware/commands/${commandId}`, A);
  const commandStatus = (status.body as { data: { status: string; result: Record<string, unknown> } }).data;
  step("POS: command completed", commandStatus.status === "completed", `detail: ${JSON.stringify(commandStatus.result)}`);

  // 7. Audit trail exists.
  const audit = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await audit.connect();
  const actions = await audit.query(
    `SELECT action FROM audit_log WHERE entity_type = 'hardware_command' AND entity_id = $1 ORDER BY id`,
    [commandId],
  );
  const terminalAudit = await audit.query(
    `SELECT action FROM audit_log WHERE entity_type = 'pos_terminal' AND entity_id = $1 ORDER BY id`,
    [pair.terminalId],
  );
  await audit.end();
  step(
    "audit: command created + settled",
    actions.rows.map((r) => r.action).join(",").includes("hardware.command_created") &&
      actions.rows.map((r) => r.action).join(",").includes("hardware.command_completed"),
    actions.rows.map((r) => r.action).join(", "),
  );
  step("audit: terminal paired", terminalAudit.rows.some((r) => r.action === "pos_terminal.paired"));

  // 8. Terminal secret auth: wrong secret rejected.
  const bad = await fetch(`${baseUrl}/api/bridge/terminal`, {
    headers: {
      Authorization: "Bearer ezpos_tb_ffffffffffffffffffffffffffffffffffffffffffffffff",
      "X-Terminal-Id": String(pair.terminalId),
    },
  });
  step("security: forged bridge secret rejected", bad.status === 401);
} finally {
  printer.close();
  server.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log(fail === 0 ? "\nE2E chain: ALL GREEN" : `\nE2E chain: ${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
