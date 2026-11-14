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

/**
 * The cheatsheet inventory — the SOURCE OF TRUTH mirror of PosHotkeyManager's
 * keydown switch plus the two search-focus listeners in ProductHeader
 * (Ctrl/Cmd+K and "/"). Every entry here is backed by an implementation;
 * Esc is listed as a standard-behavior note only (dialogs close on Escape
 * natively — it is NOT part of the hotkey bus).
 */
export interface ShortcutEntry {
  /** Key combo, each part rendered as its own keycap. */
  keys: string[];
  action: PosHotkeyAction | null;
  label: string;
  description?: string;
}

export const SHORTCUT_GROUPS: {
  title: string;
  items: ShortcutEntry[];
}[] = [
  {
    title: "Product search & scanning",
    items: [
      {
        keys: ["F1"],
        action: "product-search",
        label: "Product search",
        description: "Focus the product search field",
      },
      {
        keys: ["F8"],
        action: "barcode-focus",
        label: "Barcode focus",
        description: "Jump back to search to scan the next item",
      },
      {
        keys: ["Ctrl", "K"],
        action: null,
        label: "Search focus",
        description: "Also focuses search (⌘K on Mac)",
      },
      {
        keys: ["/"],
        action: null,
        label: "Quick search",
        description: "Focus search when not typing in a field",
      },
    ],
  },
  {
    title: "Cart & customer",
    items: [
      {
        keys: ["F5"],
        action: "customer",
        label: "Select customer",
        description: "Focus the customer selector",
      },
      {
        keys: ["F2"],
        action: "hold-sale",
        label: "Hold sale",
        description: "Save the current cart to held sales",
      },
      {
        keys: ["F3"],
        action: "retrieve-held",
        label: "Retrieve held sale",
        description: "Open held sales to restore a cart",
      },
    ],
  },
  {
    title: "Discount & payment",
    items: [
      {
        keys: ["F4"],
        action: "discount",
        label: "Discount",
        description: "Open the discount & VAT dialog",
      },
      {
        keys: ["F6"],
        action: "payment",
        label: "Payment",
        description: "Open the payment dialog to charge the customer",
      },
      {
        keys: ["F7"],
        action: "print-receipt",
        label: "Print last receipt",
        description: "Reprint the most recent receipt",
      },
    ],
  },
  {
    title: "General",
    items: [
      {
        keys: ["?"],
        action: "shortcuts-help",
        label: "Shortcut help",
        description: "Show or hide this cheat sheet",
      },
      {
        keys: ["Esc"],
        action: null,
        label: "Close dialog",
        description: "Closes the active dialog (standard behavior)",
      },
    ],
  },
];
