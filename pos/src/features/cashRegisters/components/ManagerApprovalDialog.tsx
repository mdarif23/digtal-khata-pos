import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  setManagerPinApi,
  verifyPinApi,
} from "@/features/cashRegisters/registers.api";

function extractError(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: { data?: { message?: string } } }).response
      ?.data?.message === "string"
  ) {
    return (error as { response: { data: { message: string } } }).response.data
      .message;
  }
  return fallback;
}

/**
 * Manager approval dialog (Phase 1): the approving user verifies THEIR OWN
 * PIN and the minted one-time token is handed to the caller, which must
 * consume it on the operation endpoint. Minting proves identity + authority;
 * the operation endpoint re-checks permission server-side.
 */
export function ManagerApprovalDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opType: string;
  opLabel: string;
  entityType?: string;
  entityId?: number;
  payload?: Record<string, unknown>;
  reason?: string;
  onApproved: (token: string) => void;
}) {
  const [pin, setPin] = useState("");
  const [acting, setActing] = useState(false);
  const [needsPinSetup, setNeedsPinSetup] = useState(false);
  const [setupPin, setSetupPin] = useState("");
  const [setupPin2, setSetupPin2] = useState("");

  useEffect(() => {
    if (props.open) {
      setPin("");
      setNeedsPinSetup(false);
      setSetupPin("");
      setSetupPin2("");
    }
  }, [props.open]);

  async function handleVerify() {
    if (!/^\d{4,8}$/.test(pin)) {
      toast.add({ title: "PIN must be 4-8 digits.", type: "error" });
      return;
    }
    setActing(true);
    try {
      const minted = await verifyPinApi({
        pin,
        opType: props.opType,
        ...(props.entityType ? { entityType: props.entityType } : {}),
        ...(props.entityId !== undefined ? { entityId: props.entityId } : {}),
        ...(props.payload ? { payload: props.payload } : {}),
        ...(props.reason ? { reason: props.reason } : {}),
      });
      props.onApproved(minted.approvalToken);
      props.onOpenChange(false);
    } catch (error) {
      const message = extractError(error, "Unable to verify the PIN.");
      if (message.toLowerCase().includes("no manager pin")) {
        setNeedsPinSetup(true);
      }
      toast.add({ title: message, type: "error" });
    } finally {
      setActing(false);
    }
  }

  async function handleSetPin() {
    if (setupPin !== setupPin2) {
      toast.add({ title: "PINs do not match.", type: "error" });
      return;
    }
    setActing(true);
    try {
      await setManagerPinApi(setupPin);
      toast.add({ title: "Manager PIN saved — approve again.", type: "success" });
      setNeedsPinSetup(false);
      setPin("");
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to save the PIN."), type: "error" });
    } finally {
      setActing(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4" /> Manager approval
          </DialogTitle>
          <DialogDescription>
            {needsPinSetup
              ? "Set your personal manager PIN first — you'll use it to approve sensitive operations."
              : `Enter YOUR manager PIN to approve: ${props.opLabel}. The approval is one-time and expires in 10 minutes.`}
          </DialogDescription>
        </DialogHeader>

        {needsPinSetup ? (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="map-pin-new">New PIN (4-8 digits)</Label>
              <Input
                id="map-pin-new"
                type="password"
                inputMode="numeric"
                maxLength={8}
                value={setupPin}
                onChange={(e) => setSetupPin(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="map-pin-confirm">Confirm PIN</Label>
              <Input
                id="map-pin-confirm"
                type="password"
                inputMode="numeric"
                maxLength={8}
                value={setupPin2}
                onChange={(e) => setSetupPin2(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <DialogFooter>
              <Button onClick={() => void handleSetPin()} disabled={acting}>
                {acting ? <Spinner className="size-4" /> : "Save PIN"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="map-pin">Manager PIN</Label>
              <Input
                id="map-pin"
                type="password"
                inputMode="numeric"
                autoFocus
                maxLength={8}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleVerify();
                }}
              />
            </div>
            {props.reason ? (
              <p className="text-xs text-muted-foreground">Reason: {props.reason}</p>
            ) : null}
            <DialogFooter>
              <Button onClick={() => void handleVerify()} disabled={acting || pin.length < 4}>
                {acting ? <Spinner className="size-4" /> : "Approve"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
