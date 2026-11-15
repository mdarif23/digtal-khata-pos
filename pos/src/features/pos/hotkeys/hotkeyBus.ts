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
  /** i18n key in the pos namespace (Phase 5) — the English `label` above is
   *  the render-time defaultValue. */
  labelKey: string;
  description?: string;
  descriptionKey?: string;
}

export const SHORTCUT_GROUPS: {
  title: string;
  titleKey: string;
  items: ShortcutEntry[];
}[] = [
  {
    title: "Product search & scanning",
    titleKey: "pos:hotkeys.groupProducts",
    items: [
      {
        keys: ["F1"],
        action: "product-search",
        label: "Product search",
        labelKey: "pos:hotkeys.productSearch",
        description: "Focus the product search field",
        descriptionKey: "pos:hotkeys.productSearchDesc",
      },
      {
        keys: ["F8"],
        action: "barcode-focus",
        label: "Barcode focus",
        labelKey: "pos:hotkeys.barcodeFocus",
        description: "Jump back to search to scan the next item",
        descriptionKey: "pos:hotkeys.barcodeFocusDesc",
      },
      {
        keys: ["Ctrl", "K"],
        action: null,
        label: "Search focus",
        labelKey: "pos:hotkeys.searchFocus",
        description: "Also focuses search (⌘K on Mac)",
        descriptionKey: "pos:hotkeys.searchFocusDesc",
      },
      {
        keys: ["/"],
        action: null,
        label: "Quick search",
        labelKey: "pos:hotkeys.quickSearch",
        description: "Focus search when not typing in a field",
        descriptionKey: "pos:hotkeys.quickSearchDesc",
      },
    ],
  },
  {
    title: "Cart & customer",
    titleKey: "pos:hotkeys.groupCart",
    items: [
      {
        keys: ["F5"],
        action: "customer",
        label: "Select customer",
        labelKey: "pos:hotkeys.selectCustomer",
        description: "Focus the customer selector",
        descriptionKey: "pos:hotkeys.selectCustomerDesc",
      },
      {
        keys: ["F2"],
        action: "hold-sale",
        label: "Hold sale",
        labelKey: "pos:hotkeys.holdSale",
        description: "Save the current cart to held sales",
        descriptionKey: "pos:hotkeys.holdSaleDesc",
      },
      {
        keys: ["F3"],
        action: "retrieve-held",
        label: "Retrieve held sale",
        labelKey: "pos:hotkeys.retrieveHeld",
        description: "Open held sales to restore a cart",
        descriptionKey: "pos:hotkeys.retrieveHeldDesc",
      },
    ],
  },
  {
    title: "Discount & payment",
    titleKey: "pos:hotkeys.groupPayment",
    items: [
      {
        keys: ["F4"],
        action: "discount",
        label: "Discount",
        labelKey: "pos:hotkeys.discount",
        description: "Open the discount & VAT dialog",
        descriptionKey: "pos:hotkeys.discountDesc",
      },
      {
        keys: ["F6"],
        action: "payment",
        label: "Payment",
        labelKey: "pos:hotkeys.payment",
        description: "Open the payment dialog to charge the customer",
        descriptionKey: "pos:hotkeys.paymentDesc",
      },
      {
        keys: ["F7"],
        action: "print-receipt",
        label: "Print last receipt",
        labelKey: "pos:hotkeys.printLastReceipt",
        description: "Reprint the most recent receipt",
        descriptionKey: "pos:hotkeys.printLastReceiptDesc",
      },
    ],
  },
  {
    title: "General",
    titleKey: "pos:hotkeys.groupGeneral",
    items: [
      {
        keys: ["?"],
        action: "shortcuts-help",
        label: "Shortcut help",
        labelKey: "pos:hotkeys.shortcutHelp",
        description: "Show or hide this cheat sheet",
        descriptionKey: "pos:hotkeys.shortcutHelpDesc",
      },
      {
        keys: ["Esc"],
        action: null,
        label: "Close dialog",
        labelKey: "pos:hotkeys.closeDialog",
        description: "Closes the active dialog (standard behavior)",
        descriptionKey: "pos:hotkeys.closeDialogDesc",
      },
    ],
  },
];
