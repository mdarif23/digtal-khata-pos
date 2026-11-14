import { useState } from "react";
import { Keyboard, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/common/Kbd";
import { emitHotkey } from "./hotkeyBus";

const DISMISSED_KEY = "ezpos.pos.shortcutsHintDismissed";

/**
 * First-time guidance for the POS register: a small, dismissible hint shown
 * only while the cart is empty, so it never sits between a cashier and a
 * live checkout. Dismissal persists in localStorage (frontend preference
 * only) and the ⌨ Shortcuts button stays available regardless.
 */
export function ShortcutsHint() {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISSED_KEY) === "1",
  );

  if (dismissed) return null;

  return (
    <div className="mt-4 flex w-full max-w-sm items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2.5 text-left">
      <Keyboard
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        Work faster with keyboard shortcuts.{" "}
        <button
          type="button"
          className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
          onClick={() => emitHotkey("shortcuts-help")}
        >
          View all shortcuts
        </button>
        {" — "}
        <Kbd keys={["?"]} />
      </p>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss keyboard shortcuts hint"
        className="shrink-0 text-muted-foreground"
        onClick={() => {
          localStorage.setItem(DISMISSED_KEY, "1");
          setDismissed(true);
        }}
      >
        <X />
      </Button>
    </div>
  );
}
