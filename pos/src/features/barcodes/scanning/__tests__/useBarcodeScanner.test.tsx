import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBarcodeScanner } from "../useBarcodeScanner.js";
import type { LookupMatch } from "../../barcode.api.js";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("../../barcode.api.js", () => ({
  lookupBarcodeApi: lookupMock,
}));

function makeMatch(): LookupMatch {
  return {
    matchType: "primary",
    variantId: 1,
    productId: 10,
    productName: "Cola",
    variantLabel: null,
    sku: "SKU-1",
    barcode: "4006381333931",
    barcodeFormat: "ean13",
    sellingPrice: 100,
    hasVariants: false,
    productStatus: "active",
    variantStatus: "active",
    trackingType: "none",
    stockAtLocation: 5,
    purchaseCost: null,
  };
}

const keyDown = (key: string, target?: EventTarget) =>
  act(async () => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true });
    Object.defineProperty(event, "target", { value: target ?? window });
    window.dispatchEvent(event);
  });

/** Type a code fast enough to count as a scanner burst (jsdom timestamps). */
async function wedgeScan(code: string) {
  for (const char of code) {
    await keyDown(char);
  }
  await keyDown("Enter");
}

describe("useBarcodeScanner", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("window capture turns wedge bursts into scans", async () => {
    lookupMock.mockResolvedValue(makeMatch());
    const onResolve = vi.fn();
    renderHook(() =>
      useBarcodeScanner({ capture: "window", onResolve }),
    );

    await wedgeScan("4006381333931");

    expect(lookupMock).toHaveBeenCalledWith("4006381333931");
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onResolve).toHaveBeenCalledWith(makeMatch());
  });

  it("never intercepts typing inside inputs and form fields", async () => {
    const onResolve = vi.fn();
    renderHook(() => useBarcodeScanner({ capture: "window", onResolve }));

    const input = document.createElement("input");
    document.body.appendChild(input);
    // A scanner-fast burst INTO an input is the input's business.
    for (const char of "4006381333931") {
      await keyDown(char, input);
    }
    await keyDown("Enter", input);

    expect(lookupMock).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
    input.remove();
  });

  it("ignores human typing on the page (slow inter-key gaps)", async () => {
    const onResolve = vi.fn();
    renderHook(() => useBarcodeScanner({ capture: "window", onResolve }));

    // jsdom timestamps advance in real time — 60ms gaps are human-slow.
    for (const char of "4006381333931") {
      await new Promise((r) => setTimeout(r, 60));
      await keyDown(char);
    }
    await keyDown("Enter");

    expect(lookupMock).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("capture input mode does not bind page-level listeners", async () => {
    const onResolve = vi.fn();
    renderHook(() => useBarcodeScanner({ capture: "input", onResolve }));

    await wedgeScan("4006381333931");

    expect(lookupMock).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("enabled: false disables window capture", async () => {
    const onResolve = vi.fn();
    renderHook(() =>
      useBarcodeScanner({ capture: "window", enabled: false, onResolve }),
    );

    await wedgeScan("4006381333931");

    expect(lookupMock).not.toHaveBeenCalled();
  });
});
