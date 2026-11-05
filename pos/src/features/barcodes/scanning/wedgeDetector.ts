/**
 * Keyboard-wedge scanner detection (shared barcode scanning, Phase D).
 *
 * USB/Bluetooth scanners act as keyboards: a burst of characters typed far
 * faster than any human, ending with Enter. Detection is burst-length +
 * inter-key-delay based and configurable — no hardcoded timing decisions
 * in handler code. Slow Bluetooth scanners can raise maxCharDelayMs.
 */

export interface WedgeDetectorOptions {
  /** Bursts shorter than this are treated as typing. */
  minBarcodeLength?: number;
  /** Max ms between characters before the burst counts as human typing. */
  maxCharDelayMs?: number;
}

export const WEDGE_DEFAULTS = {
  minBarcodeLength: 4,
  maxCharDelayMs: 50,
} as const;

export type WedgeDecision =
  | { action: "ignore" }
  | { action: "typing" }
  | { action: "scan"; code: string };

export function createWedgeDetector(options: WedgeDetectorOptions = {}) {
  const minLength = options.minBarcodeLength ?? WEDGE_DEFAULTS.minBarcodeLength;
  const maxDelay = options.maxCharDelayMs ?? WEDGE_DEFAULTS.maxCharDelayMs;
  let buffer = "";
  let lastKeyAt = -Infinity;

  return {
    reset() {
      buffer = "";
      lastKeyAt = -Infinity;
    },
    /**
     * Feed one keydown key; `now` is the event timestamp (DOM high-res
     * clock). Printable characters build the burst, Enter decides it.
     */
    feed(key: string, now: number): WedgeDecision {
      if (key === "Enter") {
        const code = buffer;
        this.reset();
        if (code.length >= minLength) {
          return { action: "scan", code };
        }
        return { action: "typing" };
      }
      // Modifiers / navigation keys never build a code.
      if (key.length !== 1) {
        this.reset();
        return { action: "ignore" };
      }
      if (now - lastKeyAt > maxDelay && buffer.length > 0) {
        // Gap too long for a scanner — human typing; start over.
        buffer = "";
      }
      lastKeyAt = now;
      buffer += key;
      // Hard cap protects against runaway buffers.
      if (buffer.length > 64) this.reset();
      return { action: "typing" };
    },
  };
}

/** True when keyboard events should be left alone (typing contexts). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.isContentEditable ||
    target.getAttribute("contenteditable") === "true"
  ) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
