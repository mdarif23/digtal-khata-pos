import { useEffect, useMemo, useRef } from "react";
import { useStore, type StoreApi } from "zustand";
import {
  createBarcodeScanner,
  type BarcodeScanner,
  type BarcodeScannerOptions,
  type ScanState,
} from "./barcodeScannerService.js";
import {
  createWedgeDetector,
  isEditableTarget,
  type WedgeDetectorOptions,
} from "./wedgeDetector.js";

export interface UseBarcodeScannerOptions extends BarcodeScannerOptions {
  /**
   * "input" (default): scans enter through a focused BarcodeScannerInput.
   * "window": additionally captures keyboard-wedge bursts anywhere on the
   * page — ignored while the user is typing in an editable field, so it
   * never interferes with normal typing or form fields.
   */
  capture?: "input" | "window" | undefined;
  enabled?: boolean | undefined;
  /** Wedge tuning (window capture only). */
  wedge?: WedgeDetectorOptions | undefined;
}

export interface UseBarcodeScannerResult {
  scanner: BarcodeScanner;
  state: ScanState;
  handleScan: (raw: string) => void;
}

/**
 * Per-module scanner instance. The service only identifies barcodes —
 * business rules live in the module's `onResolve` handler.
 */
export function useBarcodeScanner(
  options: UseBarcodeScannerOptions,
): UseBarcodeScannerResult {
  const ref = useRef<BarcodeScanner | null>(null);
  if (ref.current === null) {
    ref.current = createBarcodeScanner(options);
  }
  const scanner = ref.current;

  // Handlers close over fresh state every render — keep the instance
  // pointed at the latest options.
  useEffect(() => {
    scanner.setOptions(options);
  });

  const capture = options.capture ?? "input";
  const enabled = options.enabled ?? true;
  const wedgeOptions: WedgeDetectorOptions = {
    ...(options.wedge?.minBarcodeLength !== undefined
      ? { minBarcodeLength: options.wedge.minBarcodeLength }
      : {}),
    ...(options.wedge?.maxCharDelayMs !== undefined
      ? { maxCharDelayMs: options.wedge.maxCharDelayMs }
      : {}),
  };

  useEffect(() => {
    if (capture !== "window" || !enabled) return;
    const wedge = createWedgeDetector(wedgeOptions);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        wedge.reset();
        return;
      }
      if (isEditableTarget(event.target)) {
        // Focused inputs handle their own scanning — never intercept typing.
        wedge.reset();
        return;
      }
      if (event.key === "Enter") {
        const decision = wedge.feed("Enter", event.timeStamp);
        if (decision.action === "scan") {
          event.preventDefault();
          scanner.handleScan(decision.code);
        }
        return;
      }
      wedge.feed(event.key, event.timeStamp);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [capture, enabled, scanner, wedgeOptions]);

  const state = useStore(scanner);

  return useMemo(
    () => ({
      scanner,
      state,
      handleScan: (raw: string) => scanner.handleScan(raw),
    }),
    [scanner, state],
  );
}
