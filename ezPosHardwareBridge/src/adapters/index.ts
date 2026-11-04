import type { DrawerAdapter, PrinterConfig } from "../types.js";
import { RawTcpAdapter } from "./rawTcpAdapter.js";
import { SpoolerAdapter } from "./spoolerAdapter.js";

/** Creates the adapter for a configured printer; throws on bad config. */
export function createDrawerAdapter(printer: PrinterConfig): DrawerAdapter {
  switch (printer.kind) {
    case "rawTcp":
      return new RawTcpAdapter(printer);
    case "spooler":
      return new SpoolerAdapter(printer);
  }
  throw new Error(`Unknown printer kind: ${JSON.stringify(printer)}`);
}

export { RawTcpAdapter, SpoolerAdapter };
