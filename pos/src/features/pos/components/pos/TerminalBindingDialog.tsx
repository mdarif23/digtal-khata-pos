import { useEffect, useState } from "react";
import { useSessionStore } from "@/auth/sessionStore";
import { usePermissions } from "@/hooks/usePermissions.js";
import { toast } from "@/components/ui/toast";
import axios from "../../../../api/axios.js";
import { bindThisTerminal, getBoundTerminalId } from "../../../../api/axios.js";
import { createTerminalApi } from "@/features/hardware/terminals.api.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";

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
 * The Bangladesh-typical shop is ONE PC: when no terminals exist at all and
 * the user can manage terminals, this dialog becomes a ONE-CLICK setup —
 * "Set up this PC" creates the terminal record and binds it, so offline
 * selling works without ever visiting Settings or installing the bridge
 * (drawer hardware attaches later through the bridge pairing). Managers
 * without permission (or optional binding) keep the old behavior: hidden
 * unless terminals exist or the business requires binding.
 */
export function TerminalBindingDialog() {
  const { hasPermission } = usePermissions();
  const activeLocationName = useSessionStore((s) => s.activeLocationName);
  const [open, setOpen] = useState(false);
  const [required, setRequired] = useState(false);
  const [terminals, setTerminals] = useState<TerminalOption[] | null>(null);
  const [offerSetup, setOfferSetup] = useState(false);
  const [creating, setCreating] = useState(false);

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
        if (active.length === 0) {
          if (hasPermission("pos_terminal.manage")) {
            // One-PC shop, nothing registered yet — offer the one-click
            // setup right here instead of sending the owner to Settings.
            setOfferSetup(true);
            setRequired(requireTerminal);
            setOpen(true);
            return;
          }
          if (!requireTerminal) return;
        }
        setTerminals(active);
        setRequired(requireTerminal);
        setOpen(true);
      } catch {
        // No terminal visibility (permissions) — binding stays optional and
        // the POS behaves exactly as before.
      }
    })();
    // hasPermission is a stable store read; the dialog decides once per boot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function setupThisPc() {
    setCreating(true);
    try {
      const terminal = await createTerminalApi(activeLocationName ?? "Counter 1");
      // Persist the binding and reload (same convention as bindThisTerminal).
      bindThisTerminal(terminal.id);
    } catch {
      setCreating(false);
      toast.add({
        title: "Unable to set up this PC — try again in Settings → Hardware.",
        type: "error",
        priority: "high",
      });
    }
  }

  if (terminals === null && !offerSetup) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (required && !getBoundTerminalId()) return;
        setOpen(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        {offerSetup ? (
          <>
            <DialogHeader>
              <DialogTitle>Set up this PC as your sales terminal?</DialogTitle>
              <DialogDescription>
                One click — this PC gets a terminal record so offline sales
                can sync from it. No hardware needed now; a cash drawer can
                be connected later in Settings → Hardware. You can change
                this any time.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              {!required ? (
                <Button
                  variant="ghost"
                  disabled={creating}
                  onClick={() => setOpen(false)}
                >
                  Not now
                </Button>
              ) : null}
              <Button disabled={creating} onClick={() => void setupThisPc()}>
                {creating ? (
                  <>
                    <Spinner className="size-4" /> Setting up…
                  </>
                ) : (
                  "Yes, set up this PC"
                )}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Is this computer a registered terminal?</DialogTitle>
              <DialogDescription>
                Bind this PC to a terminal so its sales and cash drawer
                sessions are attributed to it. You can change this later in
                Settings → Hardware.
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
                  No active terminals at this location yet. Ask a manager to
                  add one in Settings → Hardware.
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
