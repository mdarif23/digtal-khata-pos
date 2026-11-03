import { create } from "zustand";
import type { DeviceMode, DeviceResult, ReceiptPrintPayload } from "./types.js";
import {
  connectUsbPrinter,
  disconnectUsbPrinter,
  isUsbSupported,
  kickDrawerUsb,
  printReceiptUsb,
  usbPrinterConnected,
} from "./usb.js";

/**
 * Device manager (Module 9): tracks the configured mode and connection
 * status; every action RESOLVES a DeviceResult — hardware failures are
 * statuses, never exceptions into the sale flow. The browser-print path is
 * the permanent fallback and always reports ok (it defers to the existing
 * iframe print pipeline).
 */

interface HardwareState {
  mode: DeviceMode;
  autoDrawerKick: boolean;
  usbSupported: boolean;
  connected: boolean;
  lastError: string | null;
  setMode: (mode: DeviceMode) => void;
  setAutoDrawerKick: (value: boolean) => void;
  connect: () => Promise<DeviceResult>;
  disconnect: () => void;
  refresh: () => void;
  printReceipt: (
    payload: ReceiptPrintPayload,
    browserFallback: () => Promise<boolean>,
  ) => Promise<DeviceResult>;
  kickDrawer: (browserFallback?: () => Promise<boolean>) => Promise<DeviceResult>;
}

export const useHardwareStore = create<HardwareState>()((set, get) => ({
  mode: "browser",
  autoDrawerKick: true,
  usbSupported: isUsbSupported(),
  connected: false,
  lastError: null,

  setMode: (mode) => set({ mode }),
  setAutoDrawerKick: (value) => set({ autoDrawerKick: value }),
  refresh: () => set({ connected: usbPrinterConnected(), usbSupported: isUsbSupported() }),

  connect: async () => {
    const result = await connectUsbPrinter();
    set({
      connected: result.ok,
      lastError: result.ok ? null : (result.error ?? null),
    });
    return { ok: result.ok, mode: "usb" as const, error: result.error };
  },

  disconnect: () => {
    disconnectUsbPrinter();
    set({ connected: false });
  },

  printReceipt: async (payload, browserFallback) => {
    if (get().mode === "usb") {
      const result = await printReceiptUsb(payload);
      if (result.ok) return { ok: true, mode: "usb" };
      // Hardware failed — degrade to the browser fallback automatically.
      set({ lastError: result.error ?? "USB printing failed.", connected: usbPrinterConnected() });
      const ok = await browserFallback();
      return { ok, mode: "browser", error: result.error };
    }
    const ok = await browserFallback();
    return { ok, mode: "browser" };
  },

  kickDrawer: async (browserFallback) => {
    if (get().mode === "usb") {
      const result = await kickDrawerUsb();
      if (result.ok) return { ok: true, mode: "usb" };
      set({ lastError: result.error ?? "Drawer kick failed.", connected: usbPrinterConnected() });
      if (browserFallback) {
        const ok = await browserFallback();
        return { ok, mode: "browser", error: result.error };
      }
      return { ok: false, mode: "usb", error: result.error };
    }
    // Browser mode has no physical drawer path — the caller decides (e.g.
    // a printable drawer-kick slip or an explicit no-op).
    if (browserFallback) {
      const ok = await browserFallback();
      return { ok, mode: "browser" };
    }
    return {
      ok: false,
      mode: "browser",
      error:
        "Connect a USB receipt printer to control the cash drawer — drawer kick over the browser is not available.",
    };
  },
}));

/** Builds the ReceiptPrintPayload from the receipt data the POS already has. */
export function toPrintPayload(receipt: {
  items: { productName: string; quantity: number; unitPrice: number; lineTotal: number }[];
  subtotal: number;
  discount: number;
  vat: number;
  finalTotal: number;
  customer?: unknown;
  cashierName?: string | null;
}, shopName: string, footer: string | null): ReceiptPrintPayload {
  return {
    shopName,
    lines: receipt.items.map((item) => ({
      name: item.productName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
    })),
    subtotal: receipt.subtotal,
    discount: receipt.discount,
    vat: receipt.vat,
    finalTotal: receipt.finalTotal,
    footer,
    cashier: null,
  };
}
