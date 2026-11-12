/**
 * Hotkey event bus (Phase 3 — master prompt Feature 3). The central manager
 * translates keydowns into semantic actions; components that own the target
 * UI subscribe without prop drilling. Handlers run only when the POS page
 * mounted the manager, and the manager suppresses actions while the user is
 * typing in a field (printable keys) or a modal marked data-hotkey-ignore.
 */

export type PosHotkeyAction =
  | "product-search"
  | "barcode-focus"
  | "hold-sale"
  | "retrieve-held"
  | "discount"
  | "customer"
  | "payment"
  | "print-receipt"
  | "shortcuts-help";

type Listener = () => void;

const listeners = new Map<PosHotkeyAction, Set<Listener>>();

export function emitHotkey(action: PosHotkeyAction): void {
  for (const listener of listeners.get(action) ?? []) {
    listener();
  }
}

import { useEffect } from "react";

/** Subscribes a component to a hotkey action for its lifetime. */
export function useHotkeyAction(
  action: PosHotkeyAction,
  callback: Listener,
): void {
  useEffect(() => {
    let set = listeners.get(action);
    if (!set) {
      set = new Set();
      listeners.set(action, set);
    }
    set.add(callback);
    return () => {
      set.delete(callback);
    };
    // The bus re-fires on every render's latest callback via the ref below.
  }, [action, callback]);
}

/** The default key map shown in the cheatsheet (Shift+/ opens it). */
export const SHORTCUTS: { keys: string; action: PosHotkeyAction; label: string }[] = [
  { keys: "F1", action: "product-search", label: "Product search" },
  { keys: "F2", action: "hold-sale", label: "Hold sale" },
  { keys: "F3", action: "retrieve-held", label: "Retrieve held sale" },
  { keys: "F4", action: "discount", label: "Discount" },
  { keys: "F5", action: "customer", label: "Customer" },
  { keys: "F6", action: "payment", label: "Payment" },
  { keys: "F7", action: "print-receipt", label: "Print last receipt" },
  { keys: "F8", action: "barcode-focus", label: "Barcode / search focus" },
  { keys: "?", action: "shortcuts-help", label: "Shortcut help" },
  { keys: "Esc", action: "product-search", label: "Close dialog" },
];
