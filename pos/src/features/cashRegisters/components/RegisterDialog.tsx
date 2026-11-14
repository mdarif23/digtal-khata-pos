import { useCallback, useEffect, useState } from "react";
import { RefreshCcw, Wallet } from "lucide-react";
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
  getDenominationsApi,
  getRegistersApi,
  MOVEMENT_LABELS,
  openRegisterApi,
  reconcileRegisterApi,
  reopenRegisterApi,
  type DenominationCount,
  type ManualMovementType,
  type RegisterSession,
  type RegisterSummary,
} from "../registers.api";
import { ManagerApprovalDialog } from "./ManagerApprovalDialog";
import {
  DenominationSheet,
  sheetToPayload,
} from "./DenominationSheet";
import { formatCurrency } from "@/features/reports/utils/reportUtils";

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
 * Register management for the POS screen: open the drawer at shift start
 * (optionally counted by denominations), record cash in/out and drops during
 * the shift, run mid-shift blind counts, close with a counted-cash variance
 * report, and reopen a closed session under manager approval. The backend
 * attributes cash sales automatically.
 */
export function RegisterDialog() {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<RegisterSession | null>(null);
  const [registers, setRegisters] = useState<RegisterSummary[]>([]);
  const [denominations, setDenominations] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);

  const [registerId, setRegisterId] = useState<string>("");
  const [openingCash, setOpeningCash] = useState("0");
  const [openCounts, setOpenCounts] = useState<Record<number, string>>({});
  const [movementType, setMovementType] = useState<ManualMovementType>("cash_in");
  const [movementAmount, setMovementAmount] = useState("");
  const [movementNote, setMovementNote] = useState("");
  const [dropReference, setDropReference] = useState("");
  const [countedCash, setCountedCash] = useState("");
  // G1-01: when the business requires manager approval for cash movements,
  // the backend 403s the movement — stash the submission and raise the
  // approval dialog; the approved token retries it.
  const [movementApprovalOpen, setMovementApprovalOpen] = useState(false);
  const [pendingMovement, setPendingMovement] = useState<{
    type: ManualMovementType;
    amount: number;
    note?: string;
    referenceNo?: string;
  } | null>(null);
  const [closeCounts, setCloseCounts] = useState<Record<number, string>>({});
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [reconcileAmount, setReconcileAmount] = useState("");
  const [reconcileCounts, setReconcileCounts] = useState<Record<number, string>>({});
  const [reopenApprovalOpen, setReopenApprovalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [currentSession, registerList, denominationList] = await Promise.all([
        getCurrentSessionApi(),
        getRegistersApi().catch(() => [] as RegisterSummary[]),
        getDenominationsApi().catch(() => [] as number[]),
      ]);
      setSession(currentSession);
      setRegisters(registerList);
      setDenominations(denominationList);
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
    const sheet = sheetToPayload(denominations, openCounts);
    setActing(true);
    try {
      const opened = await openRegisterApi(Number(registerId), amount, sheet);
      toast.add({
        title: `Register opened with ${formatCurrency(opened.openingCash)}`,
        type: "success",
      });
      setSession(opened);
      setOpenCounts({});
      void load();
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to open the register."), type: "error" });
    } finally {
      setActing(false);
    }
  }

  async function submitMovement(
    opts: { approvalToken?: string } = {},
  ): Promise<{ ok: boolean; error?: unknown }> {
    if (!session || !pendingMovement) return { ok: false };
    setActing(true);
    try {
      const updated = await addCashMovementApi(
        session.id,
        pendingMovement.type,
        pendingMovement.amount,
        pendingMovement.note,
        {
          ...(pendingMovement.referenceNo
            ? { referenceNo: pendingMovement.referenceNo }
            : {}),
          ...(opts.approvalToken ? { approvalToken: opts.approvalToken } : {}),
        },
      );
      toast.add({
        title: `${MOVEMENT_LABELS[pendingMovement.type]} recorded — expected ${formatCurrency(updated.expectedCash)}`,
        type: "success",
      });
      setMovementAmount("");
      setMovementNote("");
      setDropReference("");
      setSession(updated);
      setPendingMovement(null);
      return { ok: true };
    } catch (error) {
      toast.add({
        title: extractError(error, "Unable to record the movement."),
        type: "error",
      });
      return { ok: false, error };
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
    const referenceNo =
      movementType === "safe_deposit" && dropReference.trim()
        ? dropReference.trim()
        : undefined;
    setPendingMovement({
      type: movementType,
      amount,
      ...(movementNote.trim() ? { note: movementNote.trim() } : {}),
      ...(referenceNo ? { referenceNo } : {}),
    });
    const { ok, error } = await submitMovement();
    if (
      !ok &&
      extractError(error, "")
        .toLowerCase()
        .includes("manager approval is required")
    ) {
      // The server requires a manager approval for cash movements — raise
      // the PIN dialog; the minted token retries the stashed submission.
      setMovementApprovalOpen(true);
    }
  }

  async function handleReconcile() {
    if (!session) return;
    const amount = Number(reconcileAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      toast.add({ title: "Counted cash must be zero or more.", type: "error" });
      return;
    }
    setActing(true);
    try {
      const result = await reconcileRegisterApi(
        session.id,
        amount,
        sheetToPayload(denominations, reconcileCounts),
      );
      toast.add({
        title:
          result.difference === 0
            ? "Blind count balanced"
            : `Blind count — ${result.difference > 0 ? "over" : "short"} by ${formatCurrency(Math.abs(result.difference))} (expected cash unchanged)`,
        type: result.difference === 0 ? "success" : "error",
      });
      setReconcileOpen(false);
      setReconcileAmount("");
      setReconcileCounts({});
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to reconcile the drawer."), type: "error" });
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
      const closed = await closeRegisterApi(
        session.id,
        amount,
        undefined,
        sheetToPayload(denominations, closeCounts),
      );
      const difference = closed.difference ?? 0;
      toast.add({
        title:
          difference === 0
            ? "Register closed — balanced"
            : `Register closed — ${difference > 0 ? "over" : "short"} by ${formatCurrency(Math.abs(difference))}`,
        type: difference === 0 ? "success" : "error",
      });
      setSession(closed);
      setCloseCounts({});
      // Stay open on the closed summary so a manager can reopen under
      // approval without hunting for the session.
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to close the register."), type: "error" });
    } finally {
      setActing(false);
    }
  }

  async function handleReopened(token: string) {
    if (!session) return;
    try {
      const reopened = await reopenRegisterApi(session.id, token);
      toast.add({
        title: `Session reopened — opening float ${formatCurrency(reopened.openingCash)}`,
        type: "success",
      });
      setSession(reopened);
      void load();
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to reopen the session."), type: "error" });
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
        {session && session.status === "open" ? (
          <Badge variant="secondary" className="ml-1">
            {formatCurrency(session.expectedCash)}
          </Badge>
        ) : null}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cash register</DialogTitle>
            <DialogDescription>
              {session
                ? session.status === "open"
                  ? `Open at ${session.registerName} (${session.locationName})`
                  : `Closed at ${session.registerName} — variance ${formatCurrency(session.difference ?? 0)}`
                : "Open a drawer to start taking cash payments."}
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
              <Spinner className="size-4" /> Loading…
            </div>
          ) : session && session.status === "open" ? (
            <div className="grid gap-4">
              <div className="grid grid-cols-3 gap-2 rounded-md border p-3 text-center">
                <div>
                  <div className="text-xs text-muted-foreground">Opening</div>
                  <div className="font-semibold">{formatCurrency(session.openingCash)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Expected</div>
                  <div className="font-semibold">{formatCurrency(session.expectedCash)}</div>
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
                      setMovementType(
                        (
                          [
                            "cash_in",
                            "cash_out",
                            "safe_deposit",
                            "safe_withdrawal",
                            "adjustment_in",
                            "adjustment_out",
                          ] as ManualMovementType[]
                        ).includes(value as ManualMovementType)
                          ? (value as ManualMovementType)
                          : "cash_in",
                      )
                    }
                  >
                    <SelectTrigger className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash_in">Cash in</SelectItem>
                      <SelectItem value="cash_out">Cash out</SelectItem>
                      <SelectItem value="safe_deposit">Safe deposit (drop)</SelectItem>
                      <SelectItem value="safe_withdrawal">Safe withdrawal</SelectItem>
                      <SelectItem value="adjustment_in">Adjustment +</SelectItem>
                      <SelectItem value="adjustment_out">Adjustment −</SelectItem>
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
                {movementType === "safe_deposit" ? (
                  <Input
                    placeholder="Drop reference / slip number (optional)"
                    value={dropReference}
                    onChange={(event) => setDropReference(event.target.value)}
                  />
                ) : null}
              </div>

              <div className="grid gap-2 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <Label>Close register</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setReconcileOpen((v) => !v)}
                  >
                    <RefreshCcw className="size-3.5" />
                    Mid-shift count
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Count the drawer and enter the amount. Expected cash:{" "}
                  <span className="font-medium">{formatCurrency(session.expectedCash)}</span>
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
                <DenominationSheet
                  denominations={denominations}
                  counts={closeCounts}
                  onCountsChange={setCloseCounts}
                />
              </div>

              {reconcileOpen ? (
                <div className="grid gap-2 rounded-md border border-dashed p-3">
                  <Label>Mid-shift blind count</Label>
                  <p className="text-xs text-muted-foreground">
                    Records an interim variance without changing expected cash.
                  </p>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      placeholder="Counted cash"
                      className="w-32"
                      value={reconcileAmount}
                      onChange={(event) => setReconcileAmount(event.target.value)}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={acting}
                      onClick={() => void handleReconcile()}
                    >
                      Record count
                    </Button>
                  </div>
                  <DenominationSheet
                    denominations={denominations}
                    counts={reconcileCounts}
                    onCountsChange={setReconcileCounts}
                  />
                </div>
              ) : null}
            </div>
          ) : session && session.status === "closed" ? (
            <div className="grid gap-3">
              <div className="grid grid-cols-3 gap-2 rounded-md border p-3 text-center">
                <div>
                  <div className="text-xs text-muted-foreground">Expected</div>
                  <div className="font-semibold">{formatCurrency(session.expectedCash)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Counted</div>
                  <div className="font-semibold">{formatCurrency(session.countedCash ?? 0)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Difference</div>
                  <div
                    className={`font-semibold ${(session.difference ?? 0) === 0 ? "" : (session.difference ?? 0) > 0 ? "text-emerald-600" : "text-red-600"}`}
                  >
                    {formatCurrency(session.difference ?? 0)}
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Reopening needs a manager approval — the counted cash becomes
                the new opening float and the variance stays in the audit log.
              </p>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setReopenApprovalOpen(true)}
                >
                  Reopen with manager approval
                </Button>
              </DialogFooter>
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
              <DenominationSheet
                denominations={denominations}
                counts={openCounts}
                onCountsChange={setOpenCounts}
              />
              <DialogFooter>
                <Button onClick={() => void handleOpen()} disabled={acting}>
                  {acting ? "Opening…" : "Open register"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ManagerApprovalDialog
        open={reopenApprovalOpen}
        onOpenChange={setReopenApprovalOpen}
        opType="register.reopen"
        opLabel="reopen this register session"
        entityType="register_session"
        {...(session?.id !== undefined ? { entityId: session.id } : {})}
        onApproved={(token) => void handleReopened(token)}
      />

      <ManagerApprovalDialog
        open={movementApprovalOpen}
        onOpenChange={setMovementApprovalOpen}
        opType="cash_movement"
        opLabel={
          pendingMovement
            ? `record a ${MOVEMENT_LABELS[pendingMovement.type].toLowerCase()} of ${formatCurrency(pendingMovement.amount)}`
            : "record a cash movement"
        }
        {...(pendingMovement
          ? {
              payload: {
                type: pendingMovement.type,
                amount: pendingMovement.amount,
              },
            }
          : {})}
        onApproved={(token) =>
          void submitMovement({ approvalToken: token })
        }
      />
    </>
  );
}
