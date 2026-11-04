import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";
import type { BridgeConfig, PrinterConfig, TerminalCredentials } from "../types.js";

/**
 * Config + credentials storage.
 *
 * - config.json: backend URL, poll interval, printers. Hand-editable.
 * - credentials.json: the terminal secret from pairing. Written with
 *   0600-style restrictive permissions, never logged, never echoed back.
 *
 * The data directory defaults to ~/.ezpos-bridge and can be overridden
 * with EZPOS_BRIDGE_DATA_DIR (useful for Windows services running under a
 * dedicated account).
 */

const printerSchema = z
  .object({
    name: z.string().min(1).max(100),
    kind: z.enum(["rawTcp", "spooler"]),
    pin: z.union([z.literal(2), z.literal(5)]).optional(),
    onMs: z.number().finite().min(2).max(510).optional(),
    offMs: z.number().finite().min(2).max(510).optional(),
    host: z.string().min(1).max(253).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    printerName: z.string().min(1).max(150).optional(),
  })
  .refine(
    (value) => value.kind !== "rawTcp" || typeof value.host === "string",
    { message: 'rawTcp printers require a "host".' },
  )
  .refine(
    (value) => value.kind !== "spooler" || typeof value.printerName === "string",
    { message: 'spooler printers require a Windows "printerName".' },
  );

const configSchema = z.object({
  backendUrl: z.string().url().max(300),
  pollIntervalMs: z.number().int().min(500).max(60_000).default(2_000),
  printers: z.array(printerSchema).max(10).default([]),
});

export function dataDir(): string {
  return (
    process.env.EZPOS_BRIDGE_DATA_DIR ??
    path.join(os.homedir(), ".ezpos-bridge")
  );
}

export function configPath(): string {
  return path.join(dataDir(), "config.json");
}

export function credentialsPath(): string {
  return path.join(dataDir(), "credentials.json");
}

export function parseConfig(raw: unknown): BridgeConfig {
  return configSchema.parse(raw);
}

/** Loads config.json; throws a clear error when it is missing or invalid. */
export function loadConfig(): BridgeConfig {
  const file = configPath();
  if (!fs.existsSync(file)) {
    throw new Error(
      `No config found at ${file} — create one (see README) or run "pair".`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `config.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`config.json is invalid — ${issues}`);
  }
  return parsed.data;
}

export function saveConfig(config: BridgeConfig): void {
  // Validate on save so an invalid config can never exist on disk.
  const parsed = configSchema.parse(config);
  ensureDataDir();
  fs.writeFileSync(configPath(), `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function loadCredentials(): TerminalCredentials | null {
  const file = credentialsPath();
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      terminalId?: number;
      secret?: string;
      terminalName?: string;
      locationId?: number;
      pairedAt?: string;
    };
    if (
      typeof raw.terminalId !== "number" ||
      typeof raw.secret !== "string" ||
      typeof raw.terminalName !== "string" ||
      typeof raw.locationId !== "number"
    ) {
      return null;
    }
    return {
      terminalId: raw.terminalId,
      secret: raw.secret,
      terminalName: raw.terminalName,
      locationId: raw.locationId,
      pairedAt: typeof raw.pairedAt === "string" ? raw.pairedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveCredentials(credentials: TerminalCredentials): void {
  ensureDataDir();
  fs.writeFileSync(credentialsPath(), `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function clearCredentials(): void {
  const file = credentialsPath();
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

/** Pairing-code shape: 8 chars from the backend's unambiguous alphabet. */
export function validatePairingCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-HJ-KM-NP-Z2-9]{8}$/.test(normalized)) {
    throw new Error(
      "Pairing codes are 8 characters (no I/L/O/0/1). Check the code shown in ezPos → Hardware → Pair a terminal.",
    );
  }
  return normalized;
}

function ensureDataDir(): void {
  const dir = dataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Restrictive permissions where the OS honors them (POSIX); on Windows
  // the directory inherits the service account's profile ACLs.
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Best effort.
    }
  }
}

/** Redacts a secret for logs: shows only the prefix + last 4 characters. */
export function redactSecret(secret: string): string {
  if (secret.length <= 12) return "***";
  return `${secret.slice(0, 9)}…${secret.slice(-4)}`;
}

export function hashForLogs(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Deterministic-ish device label for the pairing registry. */
export function defaultDeviceName(): string {
  return `POS ${os.hostname()}`.slice(0, 100);
}

/** Random hex helper (kept here so tests can spy the module). */
export function randomId(): string {
  return randomBytes(8).toString("hex");
}

export type { PrinterConfig };
