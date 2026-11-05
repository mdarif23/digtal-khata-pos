#!/usr/bin/env node
/**
 * Stores the sync-agent terminal credential produced by the cloud pairing
 * flow into ezPosBackend/.env (EZPOS_SYNC_TERMINAL_ID / _SECRET) and
 * verifies it against the cloud with one authenticated bootstrap call.
 *
 * The secret is shown ONCE on the cloud at pairing time; this script writes
 * it into the local .env (0600) and never prints it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
}
const terminalId = argValue("--terminal-id");
const secret = argValue("--secret");

if (!terminalId || !secret) {
  console.error("Usage: node pair.mjs --terminal-id <id> --secret <ezpos_tb_...>");
  process.exit(1);
}

const backendDir = path.resolve(new URL("..", import.meta.url).pathname, "ezPosBackend");
const envPath = path.join(backendDir, ".env");
if (!process.env.DATABASE_URL) {
  // Load DATABASE_URL from .env for the connectivity check only.
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = /^DATABASE_URL=(.*)$/.exec(line);
    if (match) process.env.DATABASE_URL = match[1];
  }
}

let env = readFileSync(envPath, "utf8");
env = env
  .split("\n")
  .filter((line) => !line.startsWith("EZPOS_SYNC_TERMINAL_ID=") && !line.startsWith("EZPOS_SYNC_TERMINAL_SECRET="))
  .join("\n");
env += `EZPOS_SYNC_TERMINAL_ID=${terminalId}\nEZPOS_SYNC_TERMINAL_SECRET=${secret}\n`;
writeFileSync(envPath, env, { mode: 0o600 });
console.log(`[pair] credential written to ${envPath} (0600).`);

// Verify: one authenticated round trip against the cloud.
const cloudUrl = (env.match(/^EZPOS_SYNC_CLOUD_URL=(.*)$/m) || [])[1] || "";
if (cloudUrl) {
  const check = spawnSync(
    "node",
    ["-e", `fetch('${cloudUrl}/api/sync/bootstrap', { headers: { Authorization: 'Bearer ${secret}', 'X-Terminal-Id': '${terminalId}' } }).then(r => { console.log('[pair] cloud responded', r.status); process.exit(r.ok ? 0 : 2); }).catch(e => { console.error('[pair] cloud unreachable:', e.message); process.exit(3); })`],
    { stdio: "inherit" },
  );
  process.exitCode = check.status ?? 0;
}
console.log("[pair] done — restart the local server to start syncing.");
