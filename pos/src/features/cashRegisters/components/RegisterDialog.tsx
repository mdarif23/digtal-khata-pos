import { useCallback, useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addCashMovementApi,
  closeRegisterApi,
  getCurrentSessionApi,
  getRegistersApi,
  openRegisterApi,
  type RegisterSession,
  type RegisterSummary,
} from "../registers.api";

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
 * Register management for the POS screen: open the drawer at shift start,
 * record cash in/out during the shift, and close with a counted-cash
 * variance report. The backend attributes cash sales automatically.
 */
export function RegisterDialog() {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<RegisterSession | null>(null);
  const [registers, setRegisters] = useState<RegisterSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);

  const [registerId, setRegisterId] = useState<string>("");
  const [openingCash, setOpeningCash] = useState("0");
  const [movementType, setMovementType] = useState<"cash_in" | "cash_out">("cash_in");
  const [movementAmount, setMovementAmount] = useState("");
  const [movementNote, setMovementNote] = useState("");
  const [countedCash, setCountedCash] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [currentSession, registerList] = await Promise.all([
        getCurrentSessionApi(),
        getRegistersApi().catch(() => [] as RegisterSummary[]),
      ]);
      setSession(currentSession);
      setRegisters(registerList);
    } catch {
      toast.add({ title: "Unable to load register state", type: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function handleOpen() {
    if (registerId === "") {
      toast.add({ title: "Choose a register.", type: "error" });
      return;
    }
    const amount = Number(openingCash);
    if (!Number.isFinite(amount) || amount < 0) {
      toast.add({ title: "Opening cash must be zero or more.", type: "error" });
      return;
    }
    setActing(true);
    try {
      const opened = await openRegisterApi(Number(registerId), amount);
      toast.add({
        title: `Register opened with ${opened.openingCash}`,
        type: "success",
      });
      setSession(opened);
      void load();
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to open the register."), type: "error" });
    } finally {
      setActing(false);
    }
  }

  async function handleMovement() {
    if (!session) return;
    const amount = Number(movementAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.add({ title: "Amount must be greater than zero.", type: "error" });
      return;
    }
    setActing(true);
    try {
      const updated = await addCashMovementApi(
        session.id,
        movementType,
        amount,
        movementNote.trim() || undefined,
      );
      toast.add({
        title: `${movementType === "cash_in" ? "Cash in" : "Cash out"} recorded — expected ${updated.expectedCash}`,
        type: "success",
      });
      setMovementAmount("");
      setMovementNote("");
      setSession(updated);
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to record the movement."), type: "error" });
    } finally {
      setActing(false);
    }
  }

  async function handleClose() {
    if (!session) return;
    const amount = Number(countedCash);
    if (!Number.isFinite(amount) || amount < 0) {
      toast.add({ title: "Counted cash must be zero or more.", type: "error" });
      return;
    }
    setActing(true);
    try {
      const closed = await closeRegisterApi(session.id, amount);
      const difference = closed.difference ?? 0;
      toast.add({
        title:
          difference === 0
            ? "Register closed — balanced"
            : `Register closed — ${difference > 0 ? "over" : "short"} by ${Math.abs(difference)}`,
        type: difference === 0 ? "success" : "error",
      });
      setSession(closed);
      setOpen(false);
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to close the register."), type: "error" });
    } finally {
      setActing(false);
    }
  }

  const availableRegisters = registers.filter(
    (r) => r.status === "active" && r.openSession === null,
  );

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
      >
        <Wallet className="size-4" />
        Register
        {session ? (
          <Badge variant="secondary" className="ml-1">
            {session.expectedCash}
          </Badge>
        ) : null}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cash register</DialogTitle>
            <DialogDescription>
              {session
                ? `Open at ${session.registerName} (${session.locationName})`
                : "Open a drawer to start taking cash payments."}
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
              <Spinner className="size-4" /> Loading…
            </div>
          ) : session ? (
            <div className="grid gap-4">
              <div className="grid grid-cols-3 gap-2 rounded-md border p-3 text-center">
                <div>
                  <div className="text-xs text-muted-foreground">Opening</div>
                  <div className="font-semibold">{session.openingCash}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Expected</div>
                  <div className="font-semibold">{session.expectedCash}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Cashier</div>
                  <div className="truncate font-semibold">{session.userName}</div>
                </div>
              </div>

              <div className="grid gap-2">
                <Label>Cash movement</Label>
                <div className="flex items-center gap-2">
                  <Select
                    value={movementType}
                    onValueChange={(value) =>
                      setMovementType(value === "cash_out" ? "cash_out" : "cash_in")
                    }
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash_in">Cash in</SelectItem>
                      <SelectItem value="cash_out">Cash out</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    min={0}
                    placeholder="Amount"
                    className="w-28"
                    value={movementAmount}
                    onChange={(event) => setMovementAmount(event.target.value)}
                  />
                  <Input
                    placeholder="Note (optional)"
                    className="flex-1"
                    value={movementNote}
                    onChange={(event) => setMovementNote(event.target.value)}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={acting}
                    onClick={() => void handleMovement()}
                  >
                    Record
                  </Button>
                </div>
              </div>

              <div className="grid gap-2 rounded-md border p-3">
                <Label>Close register</Label>
                <p className="text-xs text-muted-foreground">
                  Count the drawer and enter the amount. Expected cash:{" "}
                  <span className="font-medium">{session.expectedCash}</span>
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    placeholder="Counted cash"
                    className="w-32"
                    value={countedCash}
                    onChange={(event) => setCountedCash(event.target.value)}
                  />
                  <Button
                    variant="destructive"
                    disabled={acting}
                    onClick={() => void handleClose()}
                  >
                    {acting ? "Closing…" : "Close register"}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label>Register</Label>
                <Select
                  value={registerId || undefined}
                  onValueChange={(value) => setRegisterId(value ?? "")}
                  items={availableRegisters.map((register) => ({
                    value: String(register.id),
                    label: register.name,
                  }))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a register" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableRegisters.map((register) => (
                      <SelectItem key={register.id} value={String(register.id)}>
                        {register.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {registers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No registers yet — ask your manager to create one for this
                    location.
                  </p>
                ) : null}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="opening-cash">Opening cash</Label>
                <Input
                  id="opening-cash"
                  type="number"
                  min={0}
                  value={openingCash}
                  onChange={(event) => setOpeningCash(event.target.value)}
                />
              </div>
              <DialogFooter>
                <Button onClick={() => void handleOpen()} disabled={acting}>
                  {acting ? "Opening…" : "Open register"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
