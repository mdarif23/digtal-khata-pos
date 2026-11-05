import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PermissionButton } from "@/components/common/PermissionGuard";
import { formatCurrency, formatDateTime } from "@/features/reports/utils/reportUtils";
import {
  addCashMovementApi,
  closeRegisterApi,
  getCurrentSessionApi,
  getRegistersApi,
  getSessionApi,
  MOVEMENT_LABELS,
  openRegisterApi,
  type ManualMovementType,
} from "./registers.api";

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

const MOVEMENT_TYPES: ManualMovementType[] = [
  "cash_in",
  "cash_out",
  "safe_deposit",
  "safe_withdrawal",
  "adjustment_in",
  "adjustment_out",
];

/**
 * The operational register screen: the live drawer for the signed-in
 * cashier — overview, cash movements, the counted close, and the session's
 * transaction ledger. The compact header dialog on the POS screen covers
 * the quick path; this page is the full workstation view.
 */
export function RegisterPage() {
  const qc = useQueryClient();
  const session = useQuery({
    queryKey: ["register", "current-session"],
    queryFn: () => getCurrentSessionApi(),
    refetchInterval: 15_000,
  });
  const registers = useQuery({
    queryKey: ["register", "list"],
    queryFn: getRegistersApi,
  });

  const [registerId, setRegisterId] = useState<string>("");
  const [openingCash, setOpeningCash] = useState("0");
  const [movementType, setMovementType] = useState<ManualMovementType>("cash_in");
  const [movementAmount, setMovementAmount] = useState("");
  const [movementNote, setMovementNote] = useState("");
  const [countedCash, setCountedCash] = useState("");

  const currentSession = session.data ?? null;
  const sessionDetail = useQuery({
    queryKey: ["register", "session", currentSession?.id ?? null],
    queryFn: () => getSessionApi(currentSession!.id),
    enabled: currentSession !== null,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["register"] });
  };

  const openMutation = useMutation({
    mutationFn: (input: { registerId: number; openingCash: number }) =>
      openRegisterApi(input.registerId, input.openingCash),
    onSuccess: () => invalidate(),
    onError: (error) =>
      toast.add({
        title: extractError(error, "Unable to open the register."),
        type: "error",
        priority: "high",
      }),
  });

  const movementMutation = useMutation({
    mutationFn: (input: {
      sessionId: number;
      type: ManualMovementType;
      amount: number;
      note?: string;
    }) =>
      addCashMovementApi(
        input.sessionId,
        input.type,
        input.amount,
        input.note,
      ),
    onSuccess: () => {
      setMovementAmount("");
      setMovementNote("");
      invalidate();
    },
    onError: (error) =>
      toast.add({
        title: extractError(error, "Unable to record the movement."),
        type: "error",
        priority: "high",
      }),
  });

  const closeMutation = useMutation({
    mutationFn: (input: { sessionId: number; countedCash: number }) =>
      closeRegisterApi(input.sessionId, input.countedCash),
    onSuccess: (closed) => {
      const difference = closed.difference ?? 0;
      toast.add({
        title:
          difference === 0
            ? "Register closed — balanced"
            : `Register closed — ${difference > 0 ? "over" : "short"} by ${formatCurrency(Math.abs(difference))}`,
        type: difference === 0 ? "success" : "error",
        priority: "high",
      });
      setCountedCash("");
      invalidate();
    },
    onError: (error) =>
      toast.add({
        title: extractError(error, "Unable to close the register session."),
        type: "error",
        priority: "high",
      }),
  });

  if (session.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-slate-400">
        <Spinner className="size-4" /> Loading your register…
      </div>
    );
  }

  const availableRegisters = (registers.data ?? []).filter(
    (r) => r.status === "active" && r.openSession === null,
  );
  const expected =
    sessionDetail.data?.expectedCash ?? currentSession?.expectedCash ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Cash Register</h2>
          <p className="text-sm text-slate-500">
            {currentSession
              ? `Open at ${currentSession.registerName} · ${currentSession.locationName}${currentSession.terminalName ? ` · ${currentSession.terminalName}` : ""}`
              : "No open session — open a drawer to start taking cash."}
          </p>
        </div>
        {currentSession ? (
          <Badge variant={currentSession.status === "open" ? "default" : "secondary"}>
            {currentSession.status === "open" ? "Session open" : "Closed"}
          </Badge>
        ) : null}
      </div>

      {currentSession === null ? (
        <div className="max-w-md space-y-4 rounded-xl border border-slate-200 p-5">
          <div className="grid gap-1.5">
            <Label>Register</Label>
            <Select
              value={registerId || undefined}
              onValueChange={(value) => setRegisterId(value ?? "")}
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
            {(registers.data?.length ?? 0) === 0 ? (
              <p className="text-xs text-slate-500">
                No registers yet — a manager can create one (Registers are
                unique per location).
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="register-opening-cash">Opening cash</Label>
            <Input
              id="register-opening-cash"
              type="number"
              min={0}
              value={openingCash}
              onChange={(event) => setOpeningCash(event.target.value)}
            />
          </div>
          <PermissionButton
            permission="cash_register.open"
            disabled={openMutation.isPending || registerId === ""}
            onClick={() => {
              const amount = Number(openingCash);
              if (!Number.isFinite(amount) || amount < 0) {
                toast.add({
                  title: "Opening cash must be zero or more.",
                  type: "error",
                });
                return;
              }
              openMutation.mutate({ registerId: Number(registerId), openingCash: amount });
            }}
          >
            {openMutation.isPending ? "Opening…" : "Open register"}
          </PermissionButton>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="text-xs text-slate-500">Opening float</div>
              <div className="text-xl font-semibold">
                {formatCurrency(currentSession.openingCash)}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="text-xs text-slate-500">Expected drawer cash</div>
              <div className="text-xl font-semibold">{formatCurrency(expected)}</div>
            </div>
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="text-xs text-slate-500">Cashier</div>
              <div className="truncate text-xl font-semibold">
                {currentSession.userName}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="text-xs text-slate-500">Opened</div>
              <div className="text-sm font-semibold">
                {currentSession.openedAt === null
                  ? "—"
                  : formatDateTime(currentSession.openedAt)}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 p-4">
            <Label className="mb-2 block">Cash movement</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={movementType}
                onValueChange={(value) =>
                  setMovementType(
                    (MOVEMENT_TYPES as string[]).includes(value)
                      ? (value as ManualMovementType)
                      : "cash_in",
                  )
                }
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MOVEMENT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {MOVEMENT_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="number"
                min={0}
                placeholder="Amount"
                className="w-32"
                value={movementAmount}
                onChange={(event) => setMovementAmount(event.target.value)}
              />
              <Input
                placeholder="Reason / note (optional)"
                className="min-w-48 flex-1"
                value={movementNote}
                onChange={(event) => setMovementNote(event.target.value)}
              />
              <PermissionButton
                permission="cash_movement.create"
                variant="outline"
                disabled={
                  movementMutation.isPending ||
                  !(Number(movementAmount) > 0)
                }
                onClick={() => {
                  const amount = Number(movementAmount);
                  if (!Number.isFinite(amount) || amount <= 0) {
                    toast.add({
                      title: "Amount must be greater than zero.",
                      type: "error",
                    });
                    return;
                  }
                  movementMutation.mutate({
                    sessionId: currentSession.id,
                    type: movementType,
                    amount,
                    ...(movementNote.trim() !== ""
                      ? { note: movementNote.trim() }
                      : {}),
                  });
                }}
              >
                Record movement
              </PermissionButton>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 p-4">
            <Label className="mb-1 block">Close register</Label>
            <p className="mb-2 text-xs text-slate-500">
              Count the drawer and enter the amount. Expected:{" "}
              <span className="font-medium">{formatCurrency(expected)}</span>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="number"
                min={0}
                placeholder="Counted cash"
                className="w-40"
                value={countedCash}
                onChange={(event) => setCountedCash(event.target.value)}
              />
              {countedCash !== "" && Number.isFinite(Number(countedCash)) ? (
                <span className="text-xs text-slate-500">
                  Difference:{" "}
                  <span
                    className={
                      Number(countedCash) - expected === 0
                        ? "text-emerald-600"
                        : Number(countedCash) - expected > 0
                          ? "text-blue-600"
                          : "text-rose-600"
                    }
                  >
                    {formatCurrency(Number(countedCash) - expected)}
                  </span>
                </span>
              ) : null}
              <PermissionButton
                permission="cash_register.close"
                variant="destructive"
                disabled={
                  closeMutation.isPending ||
                  !(Number(countedCash) >= 0) ||
                  countedCash === ""
                }
                onClick={() => {
                  const amount = Number(countedCash);
                  if (!Number.isFinite(amount) || amount < 0) {
                    toast.add({
                      title: "Counted cash must be zero or more.",
                      type: "error",
                    });
                    return;
                  }
                  closeMutation.mutate({
                    sessionId: currentSession.id,
                    countedCash: amount,
                  });
                }}
              >
                {closeMutation.isPending ? "Closing…" : "Close register"}
              </PermissionButton>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Type</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                  <th className="px-4 py-2.5">Source</th>
                  <th className="px-4 py-2.5">Note</th>
                  <th className="px-4 py-2.5">By</th>
                  <th className="px-4 py-2.5">When</th>
                </tr>
              </thead>
              <tbody>
                {sessionDetail.isLoading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                      <Spinner className="mx-auto size-4" />
                    </td>
                  </tr>
                ) : (sessionDetail.data?.transactions.length ?? 0) === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                      No movements yet — cash sales and refunds land here
                      automatically.
                    </td>
                  </tr>
                ) : (
                  (sessionDetail.data?.transactions ?? []).map((tx) => (
                    <tr key={tx.id} className="border-t border-slate-100">
                      <td className="px-4 py-2.5 font-medium">
                        {MOVEMENT_LABELS[tx.type as ManualMovementType] ?? tx.type}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {formatCurrency(tx.amount)}
                      </td>
                      <td className="px-4 py-2.5 text-slate-500">
                        {tx.referenceType ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-slate-500">{tx.note ?? "—"}</td>
                      <td className="px-4 py-2.5">{tx.userName}</td>
                      <td className="px-4 py-2.5 text-slate-500">
                        {tx.createdAt === null
                          ? "—"
                          : formatDateTime(tx.createdAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
