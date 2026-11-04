import { useEffect, useState } from "react";
import { Copy, Timer } from "lucide-react";
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
import { useMintPairingCode } from "../hooks/useTerminals";

/**
 * Pairing dialog: mints a one-time code the user types into the Windows
 * hardware bridge. The code lives 10 minutes and works exactly once — the
 * bridge creates the terminal and receives its secret directly from the
 * backend, so the secret never transits the browser.
 */
export function TerminalPairDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPairedHint?: () => void;
}) {
  const mint = useMintPairingCode();
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(
    null,
  );
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (props.open) {
      setIssued(null);
    }
  }, [props.open]);

  useEffect(() => {
    if (!issued) return;
    const tick = () => {
      const left = Math.max(
        0,
        Math.floor((new Date(issued.expiresAt).getTime() - Date.now()) / 1000),
      );
      setSecondsLeft(left);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [issued]);

  async function mintCode() {
    try {
      const data = await mint.mutateAsync();
      setIssued(data);
    } catch {
      toast.add({
        title: "Unable to mint a pairing code.",
        type: "error",
        priority: "high",
      });
    }
  }

  const expired = issued !== null && secondsLeft === 0;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pair a POS terminal</DialogTitle>
          <DialogDescription>
            Open the ezPos hardware bridge on the Windows machine, choose
            “Pair”, and enter this code. The bridge receives its secret
            directly — it is never shown here.
          </DialogDescription>
        </DialogHeader>

        {issued === null ? (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              The code expires in 10 minutes and works exactly once.
            </p>
            <Button onClick={() => void mintCode()} disabled={mint.isPending}>
              {mint.isPending ? "Minting…" : "Generate pairing code"}
            </Button>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="rounded-lg border bg-muted/40 p-4 text-center">
              <div className="font-mono text-3xl font-bold tracking-[0.35em]">
                {issued.code}
              </div>
              <div className="mt-2 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Timer className="size-3.5" />
                {expired
                  ? "Expired — generate a new code"
                  : `Expires in ${Math.floor(secondsLeft / 60)}:${String(
                      secondsLeft % 60,
                    ).padStart(2, "0")}`}
                <Badge variant={expired ? "destructive" : "secondary"}>
                  {expired ? "Expired" : "Single use"}
                </Badge>
              </div>
            </div>
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(issued.code);
                  toast.add({ title: "Code copied.", type: "success" });
                } catch {
                  toast.add({
                    title: "Copy failed — type the code manually.",
                    type: "info",
                  });
                }
              }}
            >
              <Copy className="mr-1 size-4" /> Copy code
            </Button>
            {expired ? (
              <Button onClick={() => void mintCode()}>New code</Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                Once the bridge confirms pairing, the terminal appears in the
                list below.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
