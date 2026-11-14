import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/common/Kbd";
import {
  emitHotkey,
  SHORTCUT_GROUPS,
  useHotkeyAction,
  type PosHotkeyAction,
} from "./hotkeyBus";

/**
 * Centralized POS keyboard manager (Phase 3 — master prompt Feature 3):
 * F1-F8 semantic actions, Escape safety, a ? cheatsheet, and guards that
 * keep shortcuts from firing while typing in inputs or inside dialogs
 * (except the help dialog itself). Browser-reserved combos are avoided —
 * only bare function keys and printable `?` are used, with
 * preventDefault to stop F1 opening browser help.
 *
 * Discoverability: the manager also renders the always-visible ⌨ Shortcuts
 * toolbar button and the grouped help dialog, so a first-time cashier can
 * find every shortcut without knowing ? exists.
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

  // UI (first-time hint) can open the sheet through the same bus the
  // shortcuts use — no second mechanism to maintain.
  useHotkeyAction("shortcuts-help", () => setHelpOpen(true));

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label="Keyboard shortcuts"
        onClick={() => setHelpOpen(true)}
      >
        <Keyboard className="size-4" aria-hidden="true" />
        <span className="hidden md:inline">Shortcuts</span>
        <Kbd keys={["?"]} className="ml-0.5 hidden sm:inline-flex" />
      </Button>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>
              Work at the register without touching the mouse. Press{" "}
              <Kbd keys={["?"]} /> any time to show or hide this sheet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {SHORTCUT_GROUPS.map((group) => (
              <section key={group.title}>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.title}
                </h3>
                <ul className="divide-y divide-border overflow-hidden rounded-lg border">
                  {group.items.map((item) => (
                    <li
                      key={item.label}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {item.label}
                        </p>
                        {item.description ? (
                          <p className="truncate text-xs text-muted-foreground">
                            {item.description}
                          </p>
                        ) : null}
                      </div>
                      <Kbd keys={item.keys} className="shrink-0" />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export { SHORTCUT_GROUPS };
