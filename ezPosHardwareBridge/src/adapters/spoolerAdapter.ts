import { createRequire } from "node:module";
import { DrawerKickError } from "../types.js";
import type { DrawerAdapter, DrawerKickResult, PrinterConfig } from "../types.js";
import { buildDrawerKick } from "../protocols/escpos/commands.js";

/**
 * Windows spooler adapter: submits the drawer-kick bytes as a RAW print
 * job (winspool `pDatatype = "RAW"`), which the spooler passes to the
 * printer untouched. This is the standard way to reach a USB receipt
 * printer on Windows — it coexists with the vendor driver, unlike direct
 * USB (libusb) access which would fight over the device.
 *
 * UNVERIFIED ON PHYSICAL HARDWARE: implemented against the documented
 * winspool/koffi API on a development machine without a Windows printer
 * attached — run `doctor` on the target machine before trusting it.
 * Any failure here is a plain adapter error; the command is acknowledged
 * `failed` (never retried blindly) unless bytes may already have reached
 * the printer, in which case `unknown_outcome`.
 */

const require_ = createRequire(import.meta.url);

interface KoffiLibrary {
  func(name: string, ret: string, params: unknown[]): (...args: unknown[]) => unknown;
  struct(name: string, fields: Record<string, string>): unknown;
  out(value: unknown): unknown;
  pointer(value: unknown): unknown;
  alloc(type: unknown, size: number): Buffer;
  address(buffer: Buffer): number;
  decode(buffer: Buffer, offset: number | null, type: unknown, length?: number): unknown;
}

interface KoffiLike {
  load(name: string): KoffiLibrary;
  struct(name: string, fields: Record<string, string>): unknown;
  out(value: unknown): unknown;
  pointer(value: unknown): unknown;
  alloc(type: string | unknown, size: number): Buffer;
  address(buffer: Buffer): number;
  decode(buffer: Buffer, offset: number | null, type: unknown, length?: number): unknown;
}

function loadKoffi(): KoffiLike {
  if (process.platform !== "win32") {
    throw new Error("koffi/winspool requires Windows.");
  }
  // koffi is an optional dependency — bundled with the Windows installer.
  // The lazy require keeps Linux dev/CI free of native bindings.
  return require_("koffi") as KoffiLike;
}

export class SpoolerAdapter implements DrawerAdapter {
  readonly printer: PrinterConfig;

  constructor(printer: PrinterConfig) {
    if (process.platform !== "win32") {
      throw new Error(
        `Printer "${printer.name}" uses the spooler adapter, which is Windows-only.`,
      );
    }
    if (!printer.printerName) {
      throw new Error(`Printer "${printer.name}" is missing its Windows printerName.`);
    }
    this.printer = printer;
  }

  async kick(): Promise<DrawerKickResult> {
    const bytes = buildDrawerKick({
      pin: this.printer.pin ?? 2,
      onMs: this.printer.onMs,
      offMs: this.printer.offMs,
    });
    const printerName = this.printer.printerName!;
    const jobName = `ezPos drawer kick (${new Date().toISOString()})`;

    const winspool = loadWinspool();
    const handle = winspool.openPrinter(printerName);
    try {
      const accepted = winspool.writeRawJob(handle, jobName, bytes);
      return {
        sent: accepted,
        detail: {
          adapter: "spooler",
          printerName,
          pin: this.printer.pin ?? 2,
          onMs: this.printer.onMs ?? 50,
          offMs: this.printer.offMs ?? 500,
          bytes: bytes.length,
          note: "RAW job accepted by the Windows spooler; no open-sensor feedback",
        },
      };
    } finally {
      winspool.closePrinter(handle);
    }
  }

  dispose(): void {
    // Stateless — each kick opens and closes its own spooler job.
  }
}

interface WinspoolLike {
  openPrinter(name: string): number;
  closePrinter(handle: number): void;
  writeRawJob(handle: number, jobName: string, bytes: Uint8Array): boolean;
}

let cached: WinspoolLike | null = null;

function loadWinspool(): WinspoolLike {
  if (cached) return cached;
  const koffi = loadKoffi();
  const lib = koffi.load("winspool.drv");
  const DOC_INFO_1W = koffi.struct("ezpos_DOC_INFO_1W", {
    pDocName: "str16",
    pOutputFile: "void *",
    pDatatype: "str16",
  });
  const OpenPrinterW = lib.func(
    "OpenPrinterW",
    "bool",
    ["str16", koffi.out(koffi.pointer("void *")), "void *"],
  );
  const ClosePrinter = lib.func("ClosePrinter", "bool", ["void *"]);
  const StartDocPrinterW = lib.func(
    "StartDocPrinterW",
    "long",
    ["void *", "long", koffi.pointer(DOC_INFO_1W)],
  );
  const EndDocPrinter = lib.func("EndDocPrinter", "bool", ["void *"]);
  const WritePrinter = lib.func(
    "WritePrinter",
    "bool",
    ["void *", "uint8 *", "long", koffi.out(koffi.pointer("long"))],
  );

  cached = {
    openPrinter(name: string): number {
      const handleOut: unknown[] = [null];
      if (!OpenPrinterW(name, handleOut, null)) {
        throw new Error(
          `OpenPrinterW failed for "${name}" — check the exact Windows printer name (doctor lists them).`,
        );
      }
      return handleOut[0] as unknown as number;
    },
    closePrinter(handle: number): void {
      ClosePrinter(handle);
    },
    writeRawJob(handle: number, jobName: string, bytes: Uint8Array): boolean {
      const doc = { pDocName: jobName, pOutputFile: null, pDatatype: "RAW" };
      const jobId = StartDocPrinterW(handle, 1, doc);
      if (!jobId) {
        // No job was created — nothing left for the printer.
        throw new DrawerKickError(
          "StartDocPrinterW failed — the spooler refused the RAW job.",
          false,
        );
      }
      const buffer = Buffer.from(bytes);
      const writtenOut: unknown[] = [0];
      const written = WritePrinter(handle, buffer, buffer.length, writtenOut);
      const ended = EndDocPrinter(handle);
      if (!written || writtenOut[0] !== buffer.length || !ended) {
        // The job exists in the spooler — bytes may still print.
        throw new DrawerKickError(
          "WritePrinter did not accept the full drawer-kick payload.",
          true,
        );
      }
      return true;
    },
  };
  return cached;
}

/**
 * Lists printers visible to the Windows spooler (diagnostics).
 * PRINTER_INFO_4W = { LPCWSTR pPrinterName; LPCWSTR pServerName; DWORD Attributes }
 * — 12 bytes per entry on x64; the names live in the same buffer and the
 * struct holds absolute pointers, so names are decoded via koffi.address().
 */
export function listSpoolerPrinters(): string[] {
  const koffi = loadKoffi();
  const lib = koffi.load("winspool.drv");
  const EnumPrintersW = lib.func(
    "EnumPrintersW",
    "bool",
    [
      "long",
      "str16 *",
      "long",
      koffi.out(koffi.pointer("uint8")),
      "long",
      koffi.out(koffi.pointer("long")),
      koffi.out(koffi.pointer("long")),
    ],
  );
  const PRINTER_INFO_4W = koffi.struct("ezpos_PRINTER_INFO_4W", {
    pPrinterName: "uint16 *",
    pServerName: "uint16 *",
    Attributes: "long",
  });

  // PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS = 6, level 4.
  const needed: unknown[] = [0];
  const count: unknown[] = [0];
  EnumPrintersW(6, null, 4, null, 0, needed, count);
  const size = Math.max(Number(needed[0]), 1);
  const buffer = koffi.alloc("uint8", size);
  const ok = EnumPrintersW(6, null, 4, buffer, size, needed, count);
  if (!ok) {
    throw new Error("EnumPrintersW failed.");
  }
  const total = Number(count[0]);
  const bufferAddress = koffi.address(buffer);
  const names: string[] = [];
  for (let i = 0; i < total; i += 1) {
    const entry = koffi.decode(buffer, i * 12, PRINTER_INFO_4W) as {
      pPrinterName: number;
    };
    const nameOffset = entry.pPrinterName - bufferAddress;
    let name = "";
    for (let cursor = nameOffset; cursor + 1 < buffer.length; cursor += 2) {
      const code = buffer[cursor]! | (buffer[cursor + 1]! << 8);
      if (code === 0) break;
      name += String.fromCharCode(code);
    }
    if (name !== "") names.push(name);
  }
  return names;
}
