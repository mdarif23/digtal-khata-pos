#!/usr/bin/env node
import * as readline from "node:readline/promises";
import * as os from "node:os";
import {
  clearCredentials,
  dataDir,
  defaultDeviceName,
  loadConfig,
  loadCredentials,
  redactSecret,
  saveConfig,
  saveCredentials,
  validatePairingCode,
} from "./config/config.js";
import { pairTerminal } from "./services/bridgeClient.js";
import { runLoop } from "./services/commandLoop.js";
import { formatReport, runDoctor, testKick } from "./diagnostics/doctor.js";
import type { BridgeConfig } from "./types.js";

/**
 * ezPos hardware bridge CLI.
 *
 *   pair     — exchange a one-time pairing code for a terminal secret
 *   run      — claim and execute drawer commands until stopped
 *   doctor   — diagnostics (config, credentials, backend, adapters)
 *   test-kick— one deliberate drawer kick (hardware must be attached)
 *
 * The bridge is outbound-only: it talks to the ezPos backend and never
 * listens on a port. All state lives in the data dir (see config.ts).
 */

function usage(): string {
  return [
    "Usage: ezpos-bridge <command>",
    "",
    "Commands:",
    "  pair [code] [--backend <url>] [--name <name>]",
    "  run [--config <path>]           claim + execute drawer commands",
    "  doctor                          diagnostics report",
    "  test-kick                       one deliberate drawer kick",
    "",
    `Data dir: ${dataDir()} (override with EZPOS_BRIDGE_DATA_DIR)`,
  ].join("\n");
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function commandPair(args: string[]): Promise<void> {
  const backendUrl =
    argValue(args, "--backend") ??
    (await prompt("Backend URL (e.g. https://api.ezpos.example): "));
  // First positional argument is the code (flags and their values skipped).
  const positional = args.find(
    (arg, index) =>
      arg !== "--backend" &&
      arg !== "--name" &&
      args[index - 1] !== "--backend" &&
      args[index - 1] !== "--name",
  );
  const code = validatePairingCode(
    positional ?? (await prompt("Pairing code (from ezPos → Hardware → Pair a terminal): ")),
  );
  const deviceName = argValue(args, "--name") ?? defaultDeviceName();

  const deviceInfo = {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    node: process.version,
    bridge: "0.1.0",
    hostname: os.hostname(),
  };

  const result = await pairTerminal(backendUrl.replace(/\/$/, ""), code, deviceName, deviceInfo);
  saveCredentials({
    terminalId: result.terminalId,
    secret: result.secret,
    terminalName: result.terminalName,
    locationId: result.locationId,
    pairedAt: new Date().toISOString(),
  });
  // Persist the backend URL alongside the credentials unless the operator
  // is re-pointing an existing config.
  let config: BridgeConfig;
  try {
    config = loadConfig();
    config.backendUrl = backendUrl.replace(/\/$/, "");
    saveConfig(config);
  } catch {
    config = { backendUrl: backendUrl.replace(/\/$/, ""), pollIntervalMs: 2000, printers: [] };
    saveConfig(config);
  }

  console.log(`Paired as terminal #${result.terminalId} "${result.terminalName}".`);
  console.log(`Secret stored: ${redactSecret(result.secret)} (never shown again).`);
  console.log(`Backend URL saved: ${config.backendUrl}`);
  console.log("Next: configure a printer in config.json, verify with `doctor`, then `run`.");
}

function commandRun(): void {
  const config = loadConfig();
  const credentials = loadCredentials();
  if (!credentials) {
    console.error("Not paired yet — run `pair` first.");
    process.exit(2);
  }
  console.log(
    `Bridge running: terminal #${credentials.terminalId} "${credentials.terminalName}" → ${config.backendUrl}`,
  );
  console.log(`Polling every ${config.pollIntervalMs} ms. Ctrl+C to stop.`);

  let stopping = false;
  const hooks = {
    log: (message: string) => console.log(`[${new Date().toISOString()}] ${message}`),
    onError: (message: string) => console.error(`[${new Date().toISOString()}] ${message}`),
  };
  const loop = runLoop(config, credentials, {
    hooks,
    shouldStop: () => stopping,
  }).catch((error: unknown) => {
    // AuthError = terminal rotated/deleted/revoked. Exit non-zero so a
    // service wrapper surfaces it; do not spin on rejected credentials.
    hooks.onError(`Bridge stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log("\nStopping after the current cycle…");
    void Promise.race([
      loop,
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]).then(() => process.exit(process.exitCode ?? 0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function commandDoctor(args: string[]): Promise<void> {
  const report = await runDoctor();
  console.log(formatReport(report));
  if (args.includes("--test-tcp")) {
    try {
      const result = await testKick();
      console.log(`test kick: ${result}`);
    } catch (error) {
      console.error(`test kick failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

async function main(): Promise<void> {
  const [command = "", ...args] = process.argv.slice(2);
  if (args.includes("--help") || command === "help") {
    console.log(usage());
    return;
  }
  switch (command) {
    case "pair":
      await commandPair(args);
      return;
    case "run":
      commandRun();
      return;
    case "doctor":
      await commandDoctor(args);
      return;
    case "test-kick":
      console.log(await testKick());
      return;
    case "unpair":
      clearCredentials();
      console.log("Credentials removed. The terminal remains registered in ezPos — deactivate or delete it there.");
      return;
    default:
      console.log(usage());
      process.exitCode = command === "" ? 0 : 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
