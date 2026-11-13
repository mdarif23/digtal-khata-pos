import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { emitHotkey, SHORTCUTS, type PosHotkeyAction } from "./hotkeyBus";

/**
 * Centralized POS keyboard manager (Phase 3 — master prompt Feature 3):
 * F1-F8 semantic actions, Escape safety, a ? cheatsheet, and guards that
 * keep shortcuts from firing while typing in inputs or inside dialogs
 * (except the help dialog itself). Browser-reserved combos are avoided —
 * only bare function keys and printable `?` are used, with
 * preventDefault to stop F1 opening browser help.
 */

function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

function isInsideDialog(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  return target.closest("[role='dialog'], [data-state='open']") !== null;
}

export function PosHotkeyManager() {
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = ((): PosHotkeyAction | null => {
        switch (event.key) {
          case "F1":
            return "product-search";
          case "F2":
            return "hold-sale";
          case "F3":
            return "retrieve-held";
          case "F4":
            return "discount";
          case "F5":
            return "customer";
          case "F6":
            return "payment";
          case "F7":
            return "print-receipt";
          case "F8":
            return "barcode-focus";
          case "?":
            return "shortcuts-help";
          default:
            return null;
        }
      })();

      // The help dialog is driven directly (state in this component).
      if (event.key === "?" && !isTypingTarget(event.target)) {
        event.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }

      if (action === null) return;
      // Typing guard: never hijack printable typing inside fields; bare
      // function keys remain safe even there (cashier muscle memory).
      if (isTypingTarget(event.target) && !event.key.startsWith("F")) return;
      // Dialog guard: function keys do not reach into open dialogs.
      if (isInsideDialog(event.target)) return;

      event.preventDefault();
      emitHotkey(action);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Work at the register without touching the mouse. Press ? to toggle
            this sheet.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5 text-sm">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{s.label}</span>
              <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { SHORTCUTS };
