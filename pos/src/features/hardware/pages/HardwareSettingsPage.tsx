import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { HardwareSettings } from "@/features/pos/components/receipt/HardwareSettings";
import { TerminalCard } from "../components/TerminalCard";
import { TerminalPairDialog } from "../components/TerminalPairDialog";
import { useTerminals } from "../hooks/useTerminals";

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
