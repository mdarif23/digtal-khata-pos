import * as net from "node:net";
import { DrawerKickError } from "../types.js";
import type { DrawerAdapter, DrawerKickResult, PrinterConfig } from "../types.js";
import { buildDrawerKick } from "../protocols/escpos/commands.js";

/**
 * Raw TCP adapter (port 9100): the most reliable transport for network
 * receipt printers. The ESC/POS drawer-kick bytes go straight to the
 * device — no drivers, no spooler, minimal latency. Bidirectional, so
 * status queries are possible in principle (not used for drawer state).
 */
export class RawTcpAdapter implements DrawerAdapter {
  readonly printer: PrinterConfig;
  private readonly connectTimeoutMs: number;
  private readonly ioTimeoutMs: number;

  constructor(printer: PrinterConfig, timeouts?: { connectMs?: number; ioMs?: number }) {
    if (!printer.host) {
      throw new Error(`Printer "${printer.name}" is missing its host.`);
    }
    this.printer = printer;
    this.connectTimeoutMs = timeouts?.connectMs ?? 4_000;
    this.ioTimeoutMs = timeouts?.ioMs ?? 4_000;
  }

  async kick(): Promise<DrawerKickResult> {
    const bytes = buildDrawerKick({
      pin: this.printer.pin ?? 2,
      onMs: this.printer.onMs,
      offMs: this.printer.offMs,
    });
    const host = this.printer.host!;
    const port = this.printer.port ?? 9100;

    const sent = await this.writeBytes(host, port, bytes);
    return {
      sent,
      detail: {
        adapter: "rawTcp",
        host,
        port,
        pin: this.printer.pin ?? 2,
        onMs: this.printer.onMs ?? 50,
        offMs: this.printer.offMs ?? 500,
        bytes: bytes.length,
        // Honest wording: the printer ACCEPTED the job. Whether the drawer
        // physically opened cannot be sensed through this transport.
        note: "drawer-kick bytes delivered to the printer; no open-sensor feedback",
      },
    };
  }

  private writeBytes(host: string, port: number, bytes: Uint8Array): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let wrote = false;
      const socket = new net.Socket();
      const fail = (error: Error) => {
        // After a successful socket.write the bytes may have reached the
        // printer even though the final ack failed — the outcome is then
        // genuinely unknown, not merely failed.
        reject(new DrawerKickError(error.message, wrote));
      };
      const finish = (error: Error | null, value?: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) fail(error);
        else resolve(value ?? false);
      };

      socket.setTimeout(this.connectTimeoutMs);
      socket.once("error", (error) => finish(error));
      socket.once("timeout", () =>
        finish(new Error(`Connect timed out after ${this.connectTimeoutMs} ms (${host}:${port}).`)),
      );
      socket.connect(port, host, () => {
        socket.setTimeout(this.ioTimeoutMs);
        socket.write(bytes, (writeError) => {
          if (writeError) {
            finish(writeError);
            return;
          }
          wrote = true;
          socket.end(() => finish(null, true));
        });
      });
    });
  }

  dispose(): void {
    // Stateless — each kick opens and closes its own socket.
  }
}
