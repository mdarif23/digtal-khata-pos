import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { HardwareSettings } from "@/features/pos/components/receipt/HardwareSettings";
import { TerminalCard } from "../components/TerminalCard";
import { TerminalPairDialog } from "../components/TerminalPairDialog";
import { useTerminals } from "../hooks/useTerminals";
import api from "../../../api/axios.js";

/**
 * Hardware settings (Phase 3): the local receipt-printer controls (USB /
 * browser) plus the POS terminal registry — pairing a Windows hardware
 * bridge, activating/deactivating it, and choosing which terminal's drawer
 * this counter uses. Terminal commands are relayed by the backend; the
 * browser never talks to the local bridge directly, which keeps the POS
 * working under Chrome's Local Network Access restrictions.
 */
export function HardwareSettingsPage() {
  const terminals = useTerminals();
  const [pairOpen, setPairOpen] = useState(false);
  const [requireTerminal, setRequireTerminal] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<{ data: { requireTerminal: boolean } }>(
          "/pos-settings",
        );
        if (!cancelled) setRequireTerminal(res.data.data.requireTerminal);
      } catch {
        if (!cancelled) setRequireTerminal(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onToggleRequireTerminal(next: boolean) {
    const previous = requireTerminal;
    setRequireTerminal(next);
    try {
      await api.patch("/pos-settings", { requireTerminal: next });
    } catch {
      setRequireTerminal(previous);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Hardware</h2>
          <p className="text-sm text-slate-500">
            Receipt printers and cash drawers for the active location.
          </p>
        </div>
        <Button onClick={() => setPairOpen(true)}>Pair a terminal</Button>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 p-4">
        <div className="space-y-1">
          <Label htmlFor="require-terminal">Require a registered terminal for checkout</Label>
          <p className="text-sm text-slate-500">
            When on, sales are only accepted from PCs bound to an active
            terminal of this location. Unbound PCs can browse but not sell.
          </p>
        </div>
        <Switch
          id="require-terminal"
          checked={requireTerminal === true}
          disabled={requireTerminal === null}
          onCheckedChange={(checked) => void onToggleRequireTerminal(checked)}
        />
      </div>

      <HardwareSettings />

      <div className="space-y-3">
        {terminals.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-slate-400">
            <Spinner className="size-4" /> Loading terminals…
          </div>
        ) : (terminals.data?.length ?? 0) === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-400">
            <p className="text-sm">
              No POS terminals at this location yet. Install the ezPos
              hardware bridge on the Windows machine and pair it with a
              one-time code.
            </p>
          </div>
        ) : (
          (terminals.data ?? []).map((terminal) => (
            <TerminalCard key={terminal.id} terminal={terminal} />
          ))
        )}
      </div>

      <p className="text-xs text-slate-400">
        Drawer commands are authorized and audited by the backend, then relayed
        to the paired terminal. A drawer command never creates or changes a
        financial record, and a hardware failure never blocks a committed sale.
      </p>

      <TerminalPairDialog
        open={pairOpen}
        onOpenChange={(open) => {
          setPairOpen(open);
          if (!open) void terminals.refetch();
        }}
      />
    </div>
  );
}
