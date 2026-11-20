import { useEffect, useState } from "react";
import { Copy, Timer } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { API_BASE_URL } from "../../../api/axios.js";
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
  const [terminalName, setTerminalName] = useState("Counter 1");

  // The bridge appends /api/... itself — the command needs the bare origin.
  const backendOrigin = API_BASE_URL.replace(/\/api\/?$/, "");
  const bridgeZipUrl = `${backendOrigin}/downloads/ezpos-bridge-win64.zip`;
  const pairCommand = `pair.cmd --backend ${backendOrigin} --name "${
    terminalName.trim() || "Counter 1"
  }"`;

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
            Run the bridge’s pair command on the Windows POS machine (steps
            below) and enter this code when it asks. The bridge receives its
            secret directly — it is never shown here.
          </DialogDescription>
        </DialogHeader>

        {issued === null ? (
          <div className="grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="pair-terminal-name">Terminal name</Label>
              <Input
                id="pair-terminal-name"
                value={terminalName}
                maxLength={100}
                placeholder="Counter 1"
                onChange={(event) => setTerminalName(event.target.value)}
              />
            </div>
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

        <div className="grid gap-2 rounded-lg border border-border p-3">
          <ol className="list-decimal space-y-2 pl-4 text-sm text-muted-foreground">
            <li>
              <a href={bridgeZipUrl} className="underline" download>
                Download the bridge zip
              </a>{" "}
              and unzip it on the Windows POS machine.
            </li>
            <li>
              Run the pair command in the unzipped folder:
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-muted px-2 py-1.5 font-mono text-xs">
                  {pairCommand}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(pairCommand);
                      toast.add({ title: "Command copied.", type: "success" });
                    } catch {
                      toast.add({
                        title: "Copy failed — select the command text manually.",
                        type: "info",
                      });
                    }
                  }}
                >
                  <Copy className="mr-1 size-4" /> Copy
                </Button>
              </div>
            </li>
            <li>
              Paste the one-time code when the command asks for it. The
              terminal appears in Settings → Hardware once paired.
            </li>
          </ol>
          <p className="text-xs text-muted-foreground/80">
            Then keep <code className="font-mono text-xs">run.cmd</code>{" "}
            running on the machine — SETUP.txt in the zip covers printers and
            service install.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
