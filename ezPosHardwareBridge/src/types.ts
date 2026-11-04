/**
 * Shared types for the ezPos hardware bridge.
 *
 * The bridge is an OUTBOUND-ONLY client: it authenticates against the ezPos
 * backend with a terminal secret, claims drawer commands, executes them on
 * configured printers, and acknowledges the outcome. It never listens on a
 * port, never touches financial records, and never reports physical drawer
 * state it cannot actually sense.
 */

export type PrinterKind = "rawTcp" | "spooler";

export interface PrinterConfig {
  /** Free-form label shown in diagnostics. */
  name: string;
  kind: PrinterKind;
  /** ESC/POS drawer-kick parameters. */
  /** Hardware drawer pin: 2 (drawer 1) or 5 (drawer 2). Default 2. */
  pin?: 2 | 5;
  /** Pulse-on time in ms (2 ms units on the wire). Default 50. */
  onMs?: number;
  /** Pulse-off time in ms. Default 500. */
  offMs?: number;
  /** rawTcp only: printer host + port (default 9100). */
  host?: string;
  port?: number;
  /** spooler only: exact Windows printer name. */
  printerName?: string;
}

export interface BridgeConfig {
  /** ezPos backend base URL, e.g. https://api.example.com */
  backendUrl: string;
  pollIntervalMs: number;
  printers: PrinterConfig[];
}

export interface TerminalCredentials {
  terminalId: number;
  secret: string;
  terminalName: string;
  locationId: number;
  pairedAt: string;
}

/** Terminal command as delivered by the backend claim endpoint. */
export interface BridgeCommand {
  id: number;
  terminalId: number;
  type: string;
  status: string;
  saleId: number | null;
  reason: string | null;
}

/** Result of one physical drawer-kick attempt. */
export interface DrawerKickResult {
  sent: boolean;
  detail: Record<string, unknown>;
}

/**
 * Adapter failure with an honest "did bytes reach the device?" flag:
 * `bytesSent === false` means nothing left the machine (safe to report
 * `failed` — the cashier may retry deliberately); `true` means the kick
 * may have reached the printer and the outcome must be `unknown_outcome`.
 */
export class DrawerKickError extends Error {
  readonly bytesSent: boolean;
  constructor(message: string, bytesSent: boolean) {
    super(message);
    this.name = "DrawerKickError";
    this.bytesSent = bytesSent;
  }
}

export interface DrawerAdapter {
  readonly printer: PrinterConfig;
  /** Sends the drawer-open pulse. Resolves; never leaves pending timers. */
  kick(): Promise<DrawerKickResult>;
  dispose(): void;
}

export type AckStatus =
  | "validated"
  | "executing"
  | "completed"
  | "failed"
  | "unknown_outcome";
