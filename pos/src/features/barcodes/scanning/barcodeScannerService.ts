import { createStore, type StoreApi } from "zustand/vanilla";
import {
  lookupBarcodeApi,
  type LookupMatch,
  type LookupResponse,
} from "../barcode.api.js";

/**
 * Shared barcode scanning stack (global barcode scanning, Phase D).
 *
 * Architectural rule: this service only CAPTURES and IDENTIFIES. It never
 * touches a module's cart or state — each module registers an `onResolve`
 * handler and owns all of its business rules (quantity increments, stock
 * checks, eligibility). Nothing in here imports from other features, so
 * sales, purchases, receiving and inventory can never accidentally share
 * the wrong quantity logic.
 */

/** Minimal normalization: strip zero-width chars, whitespace and CR/LF. */
export function normalizeBarcode(raw: string): string {
  return raw.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}

export type ScanStatus =
  | "resolved"
  | "not_found"
  | "ambiguous"
  | "duplicate"
  | "error";

export interface ScanEvent {
  id: number;
  code: string;
  status: ScanStatus;
  match?: LookupMatch | undefined;
  /** Ambiguous detail or error message. */
  detail?: string | undefined;
  at: number;
}

export interface ScanState {
  events: ScanEvent[];
  last: ScanEvent | null;
  scanCount: number;
  /** Scans queued or currently resolving. */
  pending: number;
}

export interface BarcodeScannerOptions {
  /** Backend identification. Override in tests. */
  lookup?: (code: string) => Promise<LookupResponse>;
  /**
   * Module handler — receives a resolved product/variant and applies the
   * module's own business rules. Throwing inside it surfaces an error scan.
   */
  onResolve?: (match: LookupMatch) => void | Promise<void>;
  /** Identical code within this arrival window is a double-emit → duplicate. */
  dedupeMs?: number;
  /** How many recent events feedback UIs keep. */
  historyLimit?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULTS = {
  dedupeMs: 300,
  historyLimit: 5,
};

export interface BarcodeScanner extends StoreApi<ScanState> {
  /** Queue a raw scan (normalized, deduped, processed serially). */
  handleScan(raw: string): void;
  setOptions(options: BarcodeScannerOptions): void;
}

export function createBarcodeScanner(
  initialOptions: BarcodeScannerOptions = {},
): BarcodeScanner {
  let options: BarcodeScannerOptions = initialOptions;
  const clock = () => (options.now ? options.now() : Date.now());

  const store = createStore<ScanState>(() => ({
    events: [],
    last: null,
    scanCount: 0,
    pending: 0,
  }));

  let nextEventId = 1;

  function pushEvent(event: Omit<ScanEvent, "id" | "at">) {
    const full: ScanEvent = { ...event, id: nextEventId++, at: clock() };
    const limit = options.historyLimit ?? DEFAULTS.historyLimit;
    store.setState((state) => ({
      events: [full, ...state.events].slice(0, limit),
      last: full,
      scanCount:
        full.status === "duplicate" ? state.scanCount : state.scanCount + 1,
    }));
  }

  // Serialized queue: lookups and handlers run one at a time, in scan
  // order — no overlapping cart updates, no lost scans, no reordering.
  let chain: Promise<void> = Promise.resolve();
  let lastArrival: { code: string; at: number } | null = null;

  function enqueue(code: string) {
    store.setState((state) => ({ pending: state.pending + 1 }));
    const run = async () => {
      try {
        const lookup = options.lookup ?? lookupBarcodeApi;
        let response: LookupResponse;
        try {
          response = await lookup(code);
        } catch (error) {
          pushEvent({
            code,
            status: "error",
            detail:
              error instanceof Error && error.message
                ? error.message
                : "Scan lookup failed.",
          });
          return;
        }

        if (response.matchType === "not_found") {
          pushEvent({ code, status: "not_found" });
          return;
        }
        if (response.matchType === "ambiguous") {
          pushEvent({ code, status: "ambiguous", detail: response.detail });
          return;
        }

        try {
          await options.onResolve?.(response);
          pushEvent({ code, status: "resolved", match: response });
        } catch (error) {
          pushEvent({
            code,
            status: "error",
            detail:
              error instanceof Error && error.message
                ? error.message
                : "Scan could not be processed.",
          });
        }
      } finally {
        store.setState((state) => ({ pending: Math.max(0, state.pending - 1) }));
      }
    };
    chain = chain.then(run, run);
  }

  const scanner: BarcodeScanner = {
    ...store,
    handleScan: (raw: string) => {
      const code = normalizeBarcode(raw);
      if (code === "") return;
      const now = clock();
      // Dedupe on ARRIVAL, not on processing — a scanner re-sending the
      // same code while the first lookup is still in flight must not add
      // twice once the queue drains.
      if (
        lastArrival !== null &&
        code === lastArrival.code &&
        now - lastArrival.at < (options.dedupeMs ?? DEFAULTS.dedupeMs)
      ) {
        pushEvent({ code, status: "duplicate" });
        return;
      }
      lastArrival = { code, at: now };
      enqueue(code);
    },
    setOptions: (next: BarcodeScannerOptions) => {
      options = next;
    },
  };
  return scanner;
}
