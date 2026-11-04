import { loadConfig, loadCredentials, dataDir, redactSecret } from "../config/config.js";
import { terminalSelf } from "../services/bridgeClient.js";
import { createDrawerAdapter, RawTcpAdapter, SpoolerAdapter } from "../adapters/index.js";
import { listSpoolerPrinters } from "../adapters/spoolerAdapter.js";
import { buildDrawerKick } from "../protocols/escpos/commands.js";
import type { BridgeConfig, TerminalCredentials } from "../types.js";

export interface DoctorReport {
  dataDir: string;
  configOk: boolean;
  configError?: string;
  printers: string[];
  credentialsPresent: boolean;
  credentialsSummary?: string;
  backendOk: boolean;
  backendMessage: string;
  adapterOk: boolean;
  adapterMessage: string;
}

async function collect(
  config: BridgeConfig | null,
  credentials: TerminalCredentials | null,
): Promise<DoctorReport> {
  const printers: string[] = [];
  let adapterOk = false;
  let adapterMessage = "";

  if (config) {
    for (const printer of config.printers) {
      printers.push(
        `${printer.name} (${printer.kind}${printer.kind === "rawTcp" ? ` ${printer.host}:${printer.port ?? 9100}` : ` → ${printer.printerName ?? "?"}`})`,
      );
    }
    const first = config.printers[0];
    if (!first) {
      adapterMessage = "No printer configured — drawer commands will be refused.";
    } else {
      try {
        const adapter = createDrawerAdapter(first);
        if (adapter instanceof RawTcpAdapter) {
          adapterMessage =
            `raw TCP adapter ready for ${first.host}:${first.port ?? 9100} ` +
            "(connectivity is proven by a real kick or `doctor --test-tcp`).";
          adapterOk = true;
        } else if (adapter instanceof SpoolerAdapter) {
          let spooler = "";
          try {
            const names = listSpoolerPrinters();
            spooler = names.length > 0 ? `spooler lists ${names.length} printer(s)` : "spooler lists no printers";
          } catch (error) {
            spooler = `spooler enumeration failed: ${error instanceof Error ? error.message : String(error)}`;
          }
          adapterMessage = `spooler adapter for "${first.printerName}" — ${spooler}. UNVERIFIED binding: run a test kick on the target machine.`;
          adapterOk = process.platform === "win32";
        }
        adapter.dispose();
      } catch (error) {
        adapterMessage = `Adapter error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  let backendOk = false;
  let backendMessage = "No credentials — run `pair` first.";
  if (credentials && config) {
    try {
      const self = await terminalSelf(config.backendUrl, credentials);
      backendOk = true;
      backendMessage = `Authenticated as "${self.name}" (terminal #${self.terminalId}, location #${self.locationId}).`;
    } catch (error) {
      backendMessage = `Backend check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return {
    dataDir: dataDir(),
    configOk: config !== null,
    printers,
    credentialsPresent: credentials !== null,
    credentialsSummary: credentials
      ? `terminal #${credentials.terminalId} "${credentials.terminalName}", secret ${redactSecret(credentials.secret)}`
      : undefined,
    backendOk,
    backendMessage,
    adapterOk,
    adapterMessage,
  };
}

export async function runDoctor(): Promise<DoctorReport> {
  let config: BridgeConfig | null = null;
  let configError: string | undefined;
  try {
    config = loadConfig();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
  const credentials = loadCredentials();
  return collect(config, credentials);
}

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`ezPos hardware bridge — diagnostics`);
  lines.push(`data dir:      ${report.dataDir}`);
  lines.push(`config:        ${report.configOk ? "OK" : `MISSING/INVALID — ${report.configError ?? ""}`}`);
  if (report.printers.length > 0) {
    for (const printer of report.printers) {
      lines.push(`  printer:     ${printer}`);
    }
  }
  lines.push(`credentials:   ${report.credentialsPresent ? report.credentialsSummary : "not paired"}`);
  lines.push(`backend:       ${report.backendOk ? "OK" : "FAIL"} — ${report.backendMessage}`);
  lines.push(`adapter:       ${report.adapterOk ? "OK" : "PROBLEM"} — ${report.adapterMessage}`);
  const kick = buildDrawerKick({ pin: 2 });
  lines.push(
    `esc/pos:       kick bytes ${Array.from(kick)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ")} (ESC p pin2 50ms/500ms)`,
  );
  return lines.join("\n");
}

/** One deliberate test kick through the first configured printer. */
export async function testKick(): Promise<string> {
  const config = loadConfig();
  const printer = config.printers[0];
  if (!printer) {
    return "No printer configured — nothing to test.";
  }
  const adapter = createDrawerAdapter(printer);
  try {
    const result = await adapter.kick();
    return `Kick delivered via ${String(result.detail.adapter)} — ${JSON.stringify(result.detail)}`;
  } finally {
    adapter.dispose();
  }
}
