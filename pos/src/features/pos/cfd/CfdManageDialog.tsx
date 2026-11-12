import { useCallback, useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  listDisplaysApi,
  pairCfdApi,
  revokeDisplayApi,
  type CfdDisplayRow,
} from "./cfd.api";

/**
 * POS-side customer display management (Phase 3): pair a second screen
 * (shows the one-time code), review known displays and revoke them.
 */
export function CfdManageDialog() {
  const [open, setOpen] = useState(false);
  const [displays, setDisplays] = useState<CfdDisplayRow[]>([]);
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  const [pushTargetId, setPushTargetIdState] = useState<number | null>(null);
  useEffect(() => {
    const stored = localStorage.getItem("ezpos.cfd.pushDisplayId");
    setPushTargetIdState(stored ? Number(stored) : null);
  }, []);
  const isPushTarget = (id: number) => pushTargetId === id;
  const setPushTarget = (id: number) => {
    localStorage.setItem("ezpos.cfd.pushDisplayId", String(id));
    setPushTargetIdState(id);
    toast.add({ title: "This register now pushes its cart to that display.", type: "success" });
  };

  const load = useCallback(async () => {
    try {
      setDisplays(await listDisplaysApi());
    } catch {
      setDisplays([]);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function handlePair() {
    try {
      const { code } = await pairCfdApi();
      setPairingCode(code);
      toast.add({ title: "Pairing code created — enter it on the display.", type: "success" });
    } catch {
      toast.add({ title: "Unable to start pairing.", type: "error" });
    }
  }

  async function handleRevoke(displayId: number) {
    try {
      await revokeDisplayApi(displayId);
      await load();
      toast.add({ title: "Display revoked.", type: "success" });
    } catch {
      toast.add({ title: "Unable to revoke the display.", type: "error" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
      >
        <Monitor className="size-4" /> Display
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Customer-facing display</DialogTitle>
          <DialogDescription>
            Open <span className="font-mono">/cfd</span> on a second screen
            (tablet or monitor browser) and pair it with a code.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5 rounded-md border p-3">
            <Button variant="outline" size="sm" onClick={() => void handlePair()}>
              Generate pairing code
            </Button>
            {pairingCode ? (
              <div className="rounded-md bg-muted p-3 text-center font-mono text-3xl tracking-[0.35em]">
                {pairingCode}
              </div>
            ) : null}
          </div>

          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Known displays
            </span>
            {displays.length === 0 ? (
              <p className="text-xs text-muted-foreground">None yet.</p>
            ) : (
              displays.map((display) => (
                <div
                  key={display.id}
                  className="flex items-center justify-between rounded-md border p-2 text-sm"
                >
                  <div>
                    <div className="font-medium">{display.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {display.lastSeenAt
                        ? `last seen ${new Date(display.lastSeenAt).toLocaleString()}`
                        : "never connected"}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {display.status === "active" ? (
                      <Button
                        variant={isPushTarget(display.id) ? "default" : "outline"}
                        size="sm"
                        onClick={() => setPushTarget(display.id)}
                      >
                        {isPushTarget(display.id) ? "Pushing cart" : "Push here"}
                      </Button>
                    ) : null}
                    <Badge
                      variant={display.status === "active" ? "default" : "secondary"}
                    >
                      {display.status}
                    </Badge>
                    {display.status === "active" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleRevoke(display.id)}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
