import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { Badge } from "@/components/ui/badge.js";
import { toast } from "@/components/ui/toast.js";
import axios from "@/api/axios";
import { useHardwareStore } from "@/hardware/deviceManager";

/**
 * Hardware settings (Module 9): connection mode, USB printer connection
 * status, automatic drawer kick after cash sales, and a manual kick.
 * Manual kicks are audited server-side; automatic kicks ride the already-
 * audited cash sale.
 */
export function HardwareSettings() {
  const mode = useHardwareStore((s) => s.mode);
  const connected = useHardwareStore((s) => s.connected);
  const usbSupported = useHardwareStore((s) => s.usbSupported);
  const autoDrawerKick = useHardwareStore((s) => s.autoDrawerKick);
  const lastError = useHardwareStore((s) => s.lastError);
  const setMode = useHardwareStore((s) => s.setMode);
  const setAutoDrawerKick = useHardwareStore((s) => s.setAutoDrawerKick);
  const connect = useHardwareStore((s) => s.connect);
  const disconnect = useHardwareStore((s) => s.disconnect);
  const refresh = useHardwareStore((s) => s.refresh);
  const kickDrawer = useHardwareStore((s) => s.kickDrawer);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function onConnect() {
    setBusy(true);
    try {
      const result = await connect();
      if (result.ok) {
        setMode("usb");
        toast.add({ type: "success", description: "USB printer connected." });
      } else {
        toast.add({
          type: "error",
          description: result.error ?? "Could not connect.",
          priority: "high",
        });
      }
    } finally {
      setBusy(false);
    }
  }

  async function onKick() {
    setBusy(true);
    try {
      const result = await kickDrawer();
      if (result.ok) {
        await axios
          .post("/hardware/drawer-kick", {})
          .catch(() => undefined); // audit; never blocks the drawer
        toast.add({ type: "success", description: "Drawer kicked." });
      } else {
        toast.add({
          type: "error",
          description: result.error ?? "Drawer kick failed.",
          priority: "high",
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border bg-background p-2">
      <div className="font-semibold">Hardware</div>
      <div className="flex items-center gap-2">
        <span>Receipt printer</span>
        <select
          className="rounded-md border bg-background p-1 text-xs"
          value={mode}
          onChange={(e) => setMode(e.target.value as "browser" | "usb")}
        >
          <option value="browser">Browser print</option>
          <option value="usb" disabled={!usbSupported}>
            USB thermal printer
          </option>
        </select>
        {mode === "usb" && (
          <>
            <Badge variant={connected ? "default" : "secondary"}>
              {connected ? "Connected" : "Not connected"}
            </Badge>
            {connected ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  disconnect();
                  setMode("browser");
                }}
              >
                Disconnect
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => void onConnect()}>
                Connect printer
              </Button>
            )}
          </>
        )}
      </div>
      {lastError && <div className="text-[11px] text-destructive">{lastError}</div>}
      <div className="flex items-center gap-2">
        <Switch
          checked={autoDrawerKick}
          onCheckedChange={setAutoDrawerKick}
        />
        <span>Auto-open drawer on cash sales</span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={busy}
          onClick={() => void onKick()}
        >
          Kick drawer
        </Button>
      </div>
      <div className="text-[11px] text-muted-foreground">
        Device failures never block a sale — printing falls back to the
        browser automatically.
      </div>
    </div>
  );
}
