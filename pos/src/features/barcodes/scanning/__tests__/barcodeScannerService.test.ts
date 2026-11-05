import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBarcodeScanner, normalizeBarcode } from "../barcodeScannerService.js";
import type { LookupMatch, LookupResponse } from "../../barcode.api.js";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("../../barcode.api.js", () => ({
  lookupBarcodeApi: lookupMock,
}));

function makeMatch(overrides: Partial<LookupMatch> = {}): LookupMatch {
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
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drain the serialized queue (lookup + handler + event hops). */
async function flush() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("normalizeBarcode", () => {
  it("trims whitespace and strips zero-width characters", () => {
    expect(normalizeBarcode("  4006381333931\u200B\n")).toBe("4006381333931");
    expect(normalizeBarcode("\uFEFFEZ123\r")).toBe("EZ123");
  });

  it("keeps case-sensitive codes intact", () => {
    expect(normalizeBarcode("ez-ABC-def")).toBe("ez-ABC-def");
  });
});

describe("createBarcodeScanner", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("emits a resolved event and calls the module handler with the match", async () => {
    const match = makeMatch();
    lookupMock.mockResolvedValue(match);
    const onResolve = vi.fn();
    const scanner = createBarcodeScanner({ onResolve });

    scanner.handleScan(" 4006381333931\n");
    await flush();

    expect(lookupMock).toHaveBeenCalledWith("4006381333931");
    expect(onResolve).toHaveBeenCalledWith(match);
    const state = scanner.getState();
    expect(state.last?.status).toBe("resolved");
    expect(state.last?.match).toEqual(match);
    expect(state.scanCount).toBe(1);
    expect(state.pending).toBe(0);
  });

  it("emits not_found for unknown barcodes and never calls the handler", async () => {
    lookupMock.mockResolvedValue({ matchType: "not_found" });
    const onResolve = vi.fn();
    const scanner = createBarcodeScanner({ onResolve });

    scanner.handleScan("UNKNOWN-1");
    await flush();

    expect(onResolve).not.toHaveBeenCalled();
    expect(scanner.getState().last?.status).toBe("not_found");
  });

  it("emits ambiguous with the backend detail", async () => {
    lookupMock.mockResolvedValue({
      matchType: "ambiguous",
      detail: "registered twice",
    });
    const scanner = createBarcodeScanner({});

    scanner.handleScan("AMBIG-1");
    await flush();

    const last = scanner.getState().last;
    expect(last?.status).toBe("ambiguous");
    expect(last?.detail).toBe("registered twice");
  });

  it("emits an error event when the lookup fails (network)", async () => {
    lookupMock.mockRejectedValue(new Error("Network Error"));
    const scanner = createBarcodeScanner({});

    scanner.handleScan("4006381333931");
    await flush();

    const last = scanner.getState().last;
    expect(last?.status).toBe("error");
    expect(last?.detail).toBe("Network Error");
    expect(scanner.getState().pending).toBe(0);
  });

  it("surfaces handler business-rule failures as error scans", async () => {
    lookupMock.mockResolvedValue(makeMatch());
    const scanner = createBarcodeScanner({
      onResolve: () => {
        throw new Error("Out of stock");
      },
    });

    scanner.handleScan("4006381333931");
    await flush();

    expect(scanner.getState().last?.status).toBe("error");
    expect(scanner.getState().last?.detail).toBe("Out of stock");
  });

  it("drops identical codes inside the dedupe window (scanner double-emit)", async () => {
    let nowMs = 1_000;
    lookupMock.mockResolvedValue(makeMatch());
    const onResolve = vi.fn();
    const scanner = createBarcodeScanner({ onResolve, now: () => nowMs });

    scanner.handleScan("4006381333931");
    scanner.handleScan("4006381333931"); // double-emit, 0ms later
    await flush();

    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledTimes(1);
    const state = scanner.getState();
    expect(state.last?.status).toBe("resolved");
    expect(state.scanCount).toBe(1);

    // Deliberate re-scan after the window is NOT a duplicate.
    nowMs += 1_000;
    scanner.handleScan("4006381333931");
    await flush();
    expect(lookupMock).toHaveBeenCalledTimes(2);
    expect(onResolve).toHaveBeenCalledTimes(2);
    expect(scanner.getState().scanCount).toBe(2);
  });

  it("dedupes on arrival while the first lookup is still in flight", async () => {
    let nowMs = 1_000;
    const pending = deferred<LookupResponse>();
    lookupMock.mockReturnValue(pending.promise);
    const scanner = createBarcodeScanner({ now: () => nowMs });

    scanner.handleScan("4006381333931");
    scanner.handleScan("4006381333931"); // re-send while in flight
    await flush();

    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(scanner.getState().last?.status).toBe("duplicate");
    expect(scanner.getState().pending).toBe(1);

    pending.resolve(makeMatch());
    await flush();
    const state = scanner.getState();
    expect(state.last?.status).toBe("resolved");
    expect(state.pending).toBe(0);
  });

  it("preserves scan order and serializes processing", async () => {
    let nowMs = 1_000;
    const a = deferred<LookupResponse>();
    const b = deferred<LookupResponse>();
    const c = deferred<LookupResponse>();
    lookupMock
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(c.promise);
    const resolved: string[] = [];
    const scanner = createBarcodeScanner({
      now: () => nowMs,
      onResolve: (match) => {
        resolved.push(match.barcode);
      },
    });

    scanner.handleScan("A1");
    nowMs += 1_000;
    scanner.handleScan("B2");
    nowMs += 1_000;
    scanner.handleScan("C3");

    // Resolve in reverse order — output order must still be A, B, C.
    c.resolve(makeMatch({ barcode: "C3" }));
    await flush();
    b.resolve(makeMatch({ barcode: "B2" }));
    await flush();
    a.resolve(makeMatch({ barcode: "A1" }));
    await flush();

    expect(resolved).toEqual(["A1", "B2", "C3"]);
    expect(scanner.getState().pending).toBe(0);
  });

  it("ignores empty and whitespace-only scans", async () => {
    const scanner = createBarcodeScanner({});
    scanner.handleScan("   ");
    scanner.handleScan("");
    await flush();
    expect(lookupMock).not.toHaveBeenCalled();
    expect(scanner.getState().events).toHaveLength(0);
  });

  it("keeps only historyLimit recent events", async () => {
    let nowMs = 1_000;
    lookupMock.mockResolvedValue({ matchType: "not_found" });
    const scanner = createBarcodeScanner({ now: () => nowMs, historyLimit: 3 });

    for (let i = 0; i < 5; i++) {
      nowMs += 1_000;
      scanner.handleScan(`CODE-${i}`);
    }
    await flush();

    const events = scanner.getState().events;
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.code)).toEqual(["CODE-4", "CODE-3", "CODE-2"]);
    expect(scanner.getState().scanCount).toBe(5);
  });
});
