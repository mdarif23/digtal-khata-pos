/**
 * Hardware abstraction layer (Module 9).
 *
 * Every device capability is an interface with at least one always-available
 * fallback implementation: receipt printing falls back to the browser's
 * print pipeline (the existing iframe flow), and the cash drawer is a
 * no-op-with-status when no physical device is connected. Device failures
 * resolve — they never throw into the sale flow, so hardware problems can
 * never corrupt a transaction.
 *
 * v1 implementations:
 * - Receipt printer: browser print (fallback) + ESC/POS over WebUSB
 *   (thermal printer class 0x07), used when connected — printing without
 *   browser dialogs where supported.
 * - Cash drawer: kicked via the ESC/POS printer's drawer-pin command
 *   (the standard wired setup) when a USB printer is connected.
 * - Barcode scanners: keyboard-wedge input already works through the
 *   normal search/scan fields — no driver needed.
 * - Scales and customer-facing displays: NOT implemented (no fake drivers);
 *   the interfaces below are where they slot in.
 */

export type DeviceMode = "browser" | "usb";

export type DeviceStatus = "unavailable" | "ready" | "connected" | "error";

export interface DeviceResult {
  ok: boolean;
  mode: DeviceMode;
  error?: string;
}

export interface ReceiptPrintPayload {
  shopName: string;
  lines: {
    name: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[];
  subtotal: number;
  discount: number;
  vat: number;
  finalTotal: number;
  footer?: string | null;
  cashier?: string | null;
}
