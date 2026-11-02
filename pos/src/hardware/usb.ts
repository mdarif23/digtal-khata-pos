import type { ReceiptPrintPayload } from "./types.js";
import { buildDrawerKick, buildReceiptEscPos } from "./escpos.js";

/**
 * WebUSB thermal-printer connection (printer device class 0x07). Every
 * method resolves a DeviceResult — USB absence, permission denial, and
 * transfer failures are statuses, never exceptions thrown into the sale
 * flow. Only an explicit user gesture can request a device (browser rule),
 * so connect() must be called from a click handler.
 */

const PRINTER_CLASS_CODE = 7;

interface UsbLike {
  requestDevice(options: {
    filters: { classCode?: number }[];
  }): Promise<UsbDeviceLike>;
}

interface UsbDeviceLike {
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(number: number): Promise<void>;
  claimInterface(number: number): Promise<void>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<unknown>;
  configuration?: {
    interfaces: {
      interfaceNumber: number;
      alternate: { endpoints: { direction: string; endpointNumber: number }[] };
    }[];
  };
}

function usb(): UsbLike | null {
  return (navigator as unknown as { usb?: UsbLike }).usb ?? null;
}

export function isUsbSupported(): boolean {
  return usb() !== undefined;
}

let device: UsbDeviceLike | null = null;
let endpointNumber: number | null = null;

export async function connectUsbPrinter(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const api = usb();
  if (!api) {
    return {
      ok: false,
      error:
        "This browser does not support WebUSB — use the browser print fallback.",
    };
  }
  try {
    const requested = await api.requestDevice({
      filters: [{ classCode: PRINTER_CLASS_CODE }],
    });
    await requested.open();
    await requested.selectConfiguration(1);
    const found = requested.configuration?.interfaces.find((iface) =>
      iface.alternate.endpoints.some(
        (endpoint) => endpoint.direction === "out",
      ),
    );
    if (!found) {
      await requested.close().catch(() => undefined);
      return { ok: false, error: "No usable printer endpoint found." };
    }
    await requested.claimInterface(found.interfaceNumber);
    const endpoint = found.alternate.endpoints.find(
      (endpoint) => endpoint.direction === "out",
    )!;
    device = requested;
    endpointNumber = endpoint.endpointNumber;
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Could not connect to the printer.",
    };
  }
}

export function disconnectUsbPrinter(): void {
  const connected = device;
  device = null;
  endpointNumber = null;
  connected?.close().catch(() => undefined);
}

export function usbPrinterConnected(): boolean {
  return device !== null && endpointNumber !== null;
}

async function transfer(data: Uint8Array): Promise<void> {
  if (!device || endpointNumber === null) {
    throw new Error("No USB printer connected.");
  }
  await device.transferOut(endpointNumber, data);
}

export async function printReceiptUsb(
  payload: ReceiptPrintPayload,
): Promise<{ ok: boolean; error?: string }> {
  if (!usbPrinterConnected()) {
    return { ok: false, error: "No USB printer connected." };
  }
  try {
    await transfer(buildReceiptEscPos(payload));
    return { ok: true };
  } catch (err) {
    disconnectUsbPrinter();
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "USB printing failed — printer disconnected.",
    };
  }
}

export async function kickDrawerUsb(): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (!usbPrinterConnected()) {
    return { ok: false, error: "Connect a USB printer to kick the drawer." };
  }
  try {
    await transfer(buildDrawerKick());
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Drawer kick failed.",
    };
  }
}
