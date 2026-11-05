import { useEffect, useState } from "react";
import axios from "../../../../api/axios.js";
import { bindThisTerminal, getBoundTerminalId } from "../../../../api/axios.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface TerminalOption {
  id: number;
  name: string;
  status: string;
}

/**
 * Terminal binding (multi-terminal Phase 1): on POS boot, ask once whether
 * this computer is one of the business's registered terminals. The binding
 * attributes sales and drawer sessions to this PC (and lets the business
 * enforce checkout from registered terminals only). It is a claim, not a
 * credential — every request stays authorized by the user's session, and
 * the backend re-validates the terminal per sale.
 *
 * Hidden entirely when a terminal is already bound, when the terminal list
 * is unavailable, or when the location has no active terminals (and the
 * business does not require binding).
 */
export function TerminalBindingDialog() {
  const [open, setOpen] = useState(false);
  const [required, setRequired] = useState(false);
  const [terminals, setTerminals] = useState<TerminalOption[] | null>(null);

  useEffect(() => {
    if (getBoundTerminalId() !== null) return; // already bound — nothing to ask
    let cancelled = false;
    void (async () => {
      try {
        const [terminalRes, settingsRes] = await Promise.all([
          axios.get<{ success: boolean; data: TerminalOption[] }>("/terminals"),
          axios
            .get<{ data: { requireTerminal?: boolean } }>("/pos-settings")
            .catch(() => null),
        ]);
        if (cancelled) return;
        const requireTerminal = settingsRes?.data?.data?.requireTerminal === true;
        const active = (terminalRes.data.data ?? []).filter(
          (terminal) => terminal.status === "active",
        );
        if (active.length === 0 && !requireTerminal) return;
        setTerminals(active);
        setRequired(requireTerminal);
        setOpen(true);
      } catch {
        // No terminal visibility (permissions) — binding stays optional and
        // the POS behaves exactly as before.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (terminals === null) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (required && !getBoundTerminalId()) return;
        setOpen(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Is this computer a registered terminal?</DialogTitle>
          <DialogDescription>
            Bind this PC to a terminal so its sales and cash drawer sessions
            are attributed to it. You can change this later in Settings →
            Hardware.
            {required
              ? " This business requires sales from a registered terminal."
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {(terminals ?? []).map((terminal) => (
            <Button
              key={terminal.id}
              variant="outline"
              className="justify-start"
              onClick={() => bindThisTerminal(terminal.id)}
            >
              This is “{terminal.name}”
            </Button>
          ))}
          {(terminals ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active terminals at this location yet. Ask a manager to add
              one in Settings → Hardware.
            </p>
          ) : null}
        </div>
        {!required ? (
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
                // Deliberately NOT persisted: ask again next boot — binding
                // stays an explicit, repeatable choice.
              }}
            >
              This PC is not a terminal
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
