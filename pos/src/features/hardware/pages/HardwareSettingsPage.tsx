import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HardwareSettings } from "@/features/pos/components/receipt/HardwareSettings";
import { TerminalCard } from "../components/TerminalCard";
import { TerminalPairDialog } from "../components/TerminalPairDialog";
import { LocalSyncStatus } from "../components/LocalSyncStatus";
import { createTerminalApi } from "../terminals.api";
import { useTerminals } from "../hooks/useTerminals";
import { useSessionStore } from "../../../auth/sessionStore.js";
import api, {
  API_BASE_URL,
  bindThisTerminal,
  getBoundTerminalId,
} from "../../../api/axios.js";

/** The bridge appends /api/... itself — setup commands need the bare origin. */
const backendOrigin = API_BASE_URL.replace(/\/api\/?$/, "");

/** The zip built by the bridge's `npm run dist:zip`, served by the backend. */
const bridgeZipUrl = `${backendOrigin}/downloads/ezpos-bridge-win64.zip`;

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
  /** When set, the pair dialog mints a code FOR this existing terminal. */
  const [pairTarget, setPairTarget] = useState<{ id: number; name: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addCreating, setAddCreating] = useState(false);
  const activeLocationName = useSessionStore((s) => s.activeLocationName);
  const [requireTerminal, setRequireTerminal] = useState<boolean | null>(null);

  // This PC's terminal binding ("this browser IS terminal X") — distinct
  // from pairing (the bridge's secret) and from the drawer preference.
  const boundId = getBoundTerminalId();
  const boundTerminal =
    boundId !== null
      ? (terminals.data ?? []).find((t) => t.id === boundId)
      : undefined;
  let thisPcLine: string;
  if (boundId === null) {
    thisPcLine =
      "Not bound to a terminal. After a terminal is paired below, click “Bind this computer” on it so offline sales can sync from this PC.";
  } else if (terminals.isLoading) {
    thisPcLine = `Bound to terminal #${boundId}.`;
  } else if (boundTerminal) {
    thisPcLine = `Bound to “${boundTerminal.name}” — offline sales from this PC sync under this terminal.`;
  } else {
    thisPcLine = `Bound to terminal #${boundId}, which is not in this location’s list.`;
  }

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
          <p className="text-sm text-muted-foreground">
            Receipt printers and cash drawers for the active location.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setAddName(activeLocationName ?? "Counter 1");
              setAddOpen(true);
            }}
          >
            Add terminal
          </Button>
          <Button
            onClick={() => {
              setPairTarget(null);
              setPairOpen(true);
            }}
          >
            Connect cash drawer hardware
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl border border-border p-4">
        <div className="space-y-1">
          <Label htmlFor="require-terminal">Require a registered terminal for checkout</Label>
          <p className="text-sm text-muted-foreground">
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

      <div className="space-y-3 rounded-xl border border-border p-4">
        <div className="space-y-1">
          <h3 className="font-medium">Embedded price/weight barcodes</h3>
          <p className="text-sm text-muted-foreground">
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

      <div className="flex items-center justify-between gap-4 rounded-xl border border-border p-4">
        <div className="space-y-1">
          <h3 className="font-medium">This computer</h3>
          <p className="text-sm text-muted-foreground">{thisPcLine}</p>
        </div>
        {boundId !== null ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => bindThisTerminal(null)}
          >
            Unbind
          </Button>
        ) : null}
      </div>

      <div className="space-y-3">
        {terminals.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground/80">
            <Spinner className="size-4" /> Loading terminals…
          </div>
        ) : (terminals.data?.length ?? 0) === 0 ? (
          <div className="space-y-3 rounded-xl border border-dashed border-border p-6">
            <div>
              <h3 className="font-medium">Set up a POS terminal</h3>
              <p className="text-sm text-muted-foreground">
                <strong>No drawer hardware?</strong> Just click{" "}
                <strong>Add terminal</strong> above, name this PC, and bind it
                when the POS asks — that is all offline selling needs. The
                steps below are only for an auto-opening cash drawer:
              </p>
            </div>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              <li>
                <a href={bridgeZipUrl} className="underline" download>
                  Download the bridge zip
                </a>{" "}
                and unzip it on the machine — Windows 10/11, nothing else to
                install.
              </li>
              <li>
                Click “Connect cash drawer hardware” above and generate a
                one-time code.
              </li>
              <li>
                In the unzipped folder on the machine, run the copied{" "}
                <code className="font-mono text-xs">pair.cmd …</code>{" "}
                command — the code is already in it.
              </li>
              <li>
                Keep <code className="font-mono text-xs">run.cmd</code>{" "}
                running on the machine — it polls the backend for authorized
                drawer commands.
              </li>
            </ol>
            <p className="text-xs text-muted-foreground/80">
              SETUP.txt inside the zip covers printers and service install.
              After pairing, click “Bind this computer” on the terminal so
              this PC’s offline sales sync.
            </p>
          </div>
        ) : (
          (terminals.data ?? []).map((terminal) => (
            <TerminalCard
              key={terminal.id}
              terminal={terminal}
              onConnectDrawer={(target) => {
                setPairTarget({ id: target.id, name: target.name });
                setPairOpen(true);
              }}
            />
          ))
        )}
      </div>

      <p className="text-xs text-muted-foreground/80">
        Drawer commands are authorized and audited by the backend, then relayed
        to the paired terminal. A drawer command never creates or changes a
        financial record, and a hardware failure never blocks a committed sale.
      </p>

      <TerminalPairDialog
        open={pairOpen}
        terminal={pairTarget}
        onOpenChange={(open) => {
          setPairOpen(open);
          if (!open) void terminals.refetch();
        }}
      />

      {/* Hardware-less terminal creation: one click for offline selling. */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add terminal</DialogTitle>
            <DialogDescription>
              Registers a PC for offline selling and sale attribution — no
              hardware needed. Bind this PC to it when the POS asks. A cash
              drawer can be connected later from the terminal's card.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="add-terminal-name">Terminal name</Label>
            <Input
              id="add-terminal-name"
              value={addName}
              maxLength={100}
              onChange={(event) => setAddName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={addCreating || addName.trim() === ""}
              onClick={async () => {
                setAddCreating(true);
                try {
                  await createTerminalApi(addName.trim());
                  toast.add({
                    title: `Terminal “${addName.trim()}” added. Reload the POS on that PC and bind it.`,
                    type: "success",
                  });
                  setAddOpen(false);
                  void terminals.refetch();
                } catch {
                  toast.add({
                    title: "Unable to add the terminal.",
                    type: "error",
                    priority: "high",
                  });
                } finally {
                  setAddCreating(false);
                }
              }}
            >
              {addCreating ? "Adding…" : "Add terminal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
