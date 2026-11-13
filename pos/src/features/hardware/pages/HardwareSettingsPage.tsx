import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { HardwareSettings } from "@/features/pos/components/receipt/HardwareSettings";
import { TerminalCard } from "../components/TerminalCard";
import { TerminalPairDialog } from "../components/TerminalPairDialog";
import { LocalSyncStatus } from "../components/LocalSyncStatus";
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

  // Phase 4 (Feature 10-B): embedded price/weight barcode configuration.
  const [embedded, setEmbedded] = useState<{
    prefixes: string;
    pluLength: string;
    valueLength: string;
    decimals: string;
    mode: "weight" | "price";
    hasCheckDigit: boolean;
  } | null>(null);
  const [embeddedSaving, setEmbeddedSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<{
          data: { embeddedBarcode: Record<string, unknown> | null };
        }>("/pos-settings");
        const config = res.data.data.embeddedBarcode as {
          prefixes: string[];
          pluLength: number;
          valueLength: number;
          decimals: number;
          mode: "weight" | "price";
          hasCheckDigit: boolean;
        } | null;
        if (cancelled || !config) return;
        setEmbedded({
          prefixes: (config.prefixes as string[]).join(","),
          pluLength: String(config.pluLength),
          valueLength: String(config.valueLength),
          decimals: String(config.decimals),
          mode: config.mode,
          hasCheckDigit: config.hasCheckDigit,
        });
      } catch {
        // settings unreachable — leave null (defaults used by the scanner)
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveEmbedded() {
    if (!embedded) return;
    setEmbeddedSaving(true);
    try {
      const payload = {
        embeddedBarcode: {
          prefixes: embedded.prefixes
            .split(",")
            .map((p) => p.trim())
            .filter((p) => /^\d{1,3}$/.test(p)),
          pluLength: Number(embedded.pluLength) || 5,
          valueLength: Number(embedded.valueLength) || 5,
          decimals: Number(embedded.decimals) || 3,
          mode: embedded.mode,
          hasCheckDigit: embedded.hasCheckDigit,
        },
      };
      await api.patch("/pos-settings", payload);
      toast.add({ title: "Embedded-barcode configuration saved.", type: "success" });
    } catch {
      toast.add({ title: "Unable to save the embedded-barcode configuration.", type: "error" });
    } finally {
      setEmbeddedSaving(false);
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

      <div className="space-y-3 rounded-xl border border-slate-200 p-4">
        <div className="space-y-1">
          <h3 className="font-medium">Embedded price/weight barcodes</h3>
          <p className="text-sm text-slate-500">
            Scale barcodes shaped PREFIX + item code + value. The scanner
            parses these before catalog lookup; the item barcode stores
            PREFIX + item code. Empty = parser defaults (21 / 5 / 5 / 3
            decimals, weight, check digit on).
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6 lg:items-end">
          <div className="grid gap-1">
            <Label htmlFor="emb-prefix">Prefixes (comma-sep)</Label>
            <Input
              id="emb-prefix"
              className="h-8"
              value={embedded?.prefixes ?? ""}
              onChange={(e) =>
                setEmbedded((previous) =>
                  previous ? { ...previous, prefixes: e.target.value } : previous,
                )
              }
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="emb-plu">Item code digits</Label>
            <Input
              id="emb-plu"
              type="number"
              min={1}
              className="h-8"
              value={embedded?.pluLength ?? ""}
              onChange={(e) =>
                setEmbedded((previous) =>
                  previous ? { ...previous, pluLength: e.target.value } : previous,
                )
              }
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="emb-value">Value digits</Label>
            <Input
              id="emb-value"
              type="number"
              min={1}
              className="h-8"
              value={embedded?.valueLength ?? ""}
              onChange={(e) =>
                setEmbedded((previous) =>
                  previous ? { ...previous, valueLength: e.target.value } : previous,
                )
              }
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="emb-dec">Value decimals</Label>
            <Input
              id="emb-dec"
              type="number"
              min={0}
              max={6}
              className="h-8"
              value={embedded?.decimals ?? ""}
              onChange={(e) =>
                setEmbedded((previous) =>
                  previous ? { ...previous, decimals: e.target.value } : previous,
                )
              }
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="emb-mode">Value carries</Label>
            <select
              id="emb-mode"
              className="h-8 rounded-md border bg-background text-sm"
              value={embedded?.mode ?? "weight"}
              onChange={(e) =>
                setEmbedded((previous) =>
                  previous
                    ? { ...previous, mode: e.target.value as "weight" | "price" }
                    : previous,
                )
              }
            >
              <option value="weight">Weight (quantity)</option>
              <option value="price">Price</option>
            </select>
          </div>
          <div className="flex items-center gap-2 pb-1">
            <input
              id="emb-check"
              type="checkbox"
              checked={embedded?.hasCheckDigit ?? true}
              onChange={(e) =>
                setEmbedded((previous) =>
                  previous ? { ...previous, hasCheckDigit: e.target.checked } : previous,
                )
              }
            />
            <Label htmlFor="emb-check" className="text-sm">
              Check digit
            </Label>
          </div>
        </div>
        <Button size="sm" onClick={() => void saveEmbedded()} disabled={embeddedSaving}>
          {embeddedSaving ? "Saving…" : "Save configuration"}
        </Button>
      </div>

      <LocalSyncStatus />

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
