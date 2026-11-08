import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Coins } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { formatCurrency } from "@/features/reports/utils/reportUtils";
import { ReportTable, type ReportColumn } from "@/features/reports/components/ReportTable";
import {
  createOwnerApi,
  recordCapitalTransactionApi,
} from "../finance.api";
import {
  financeKeys,
  useCapitalSummary,
  useCapitalTransactions,
  useInvalidateFinance,
  useOwners,
} from "../hooks/useFinance";
import type { CapitalTransaction, OwnerProfile } from "../finance.types";

/**
 * Owner Capital: owner profiles, capital transactions (investments /
 * withdrawals) and the per-owner position — the Phase 1 module.
 */

type TxnKind = "investment" | "withdrawal";

export function OwnersPage() {
  const owners = useOwners();
  const summary = useCapitalSummary();
  const invalidate = useInvalidateFinance();
  const [filters, setFilters] = useState<{ type?: TxnKind }>({});
  const txns = useCapitalTransactions(filters);
  const [ownerDialogOpen, setOwnerDialogOpen] = useState(false);
  const [txnDialog, setTxnDialog] = useState<TxnKind | null>(null);

  const txnColumns: ReportColumn<CapitalTransaction>[] = [
    {
      key: "txnDate",
      header: "Date",
      render: (row) => <span>{row.txnDate}</span>,
    },
    {
      key: "ownerName",
      header: "Owner",
      render: (row) => <span className="font-medium">{row.ownerName}</span>,
    },
    {
      key: "type",
      header: "Type",
      render: (row) => (
        <Badge
          variant="outline"
          className={
            row.type === "investment"
              ? "text-xs text-emerald-700"
              : row.type === "distribution"
                ? "text-xs text-violet-700"
                : "text-xs text-amber-700"
          }
        >
          {row.type}
        </Badge>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      render: (row) => <span>{formatCurrency(row.amount)}</span>,
    },
    {
      key: "method",
      header: "Method",
      render: (row) => <span>{row.method ?? "—"}</span>,
    },
    {
      key: "sourceOfFunds",
      header: "Source of funds",
      render: (row) => <span>{row.sourceOfFunds ?? "—"}</span>,
    },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
            Finance &amp; Growth
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            Owner Capital
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Investments, withdrawals and distributions — every movement is
            GL-posted (contributions → 3010, drawings → 3020).
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setTxnDialog("withdrawal")}>
            <ArrowDownRight className="size-4" /> Record Withdrawal
          </Button>
          <Button onClick={() => setTxnDialog("investment")}>
            <ArrowUpRight className="size-4" /> Record Investment
          </Button>
        </div>
      </header>

      {summary.data && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <SummaryCard label="Contributed" value={summary.data.totals.contributed} />
          <SummaryCard label="Returned" value={summary.data.totals.returned} />
          <SummaryCard label="Distributed" value={summary.data.totals.distributed} />
          <SummaryCard label="Position" value={summary.data.totals.position} strong />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader className="flex-row items-center justify-between pb-3">
            <CardTitle className="text-base">Owners</CardTitle>
            <Button variant="outline" size="sm" onClick={() => setOwnerDialogOpen(true)}>
              Add owner
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {(owners.data ?? []).map((owner) => (
              <div
                key={owner.id}
                className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900">{owner.name}</p>
                  <p className="text-xs text-slate-500">
                    {owner.ownershipPercent != null
                      ? `${Number(owner.ownershipPercent)}% ownership`
                      : "Owner"}{" "}
                    · in {formatCurrency(owner.totals?.invested ?? "0")}
                  </p>
                </div>
                <Badge variant="outline" className="shrink-0 text-xs">
                  {formatCurrency(owner.capitalPosition ?? "0")}
                </Badge>
              </div>
            ))}
            {owners.data?.length === 0 && (
              <p className="py-4 text-center text-sm text-slate-400">
                No owner profiles yet — add the first owner.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between pb-3">
            <CardTitle className="text-base">Capital Transactions</CardTitle>
            <Select
              value={filters.type ?? "all"}
              onValueChange={(value) =>
                setFilters(value === "all" ? {} : { type: value as TxnKind })
              }
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="investment">Investments</SelectItem>
                <SelectItem value="withdrawal">Withdrawals</SelectItem>
                <SelectItem value="distribution">Distributions</SelectItem>
              </SelectContent>
            </Select>
          </CardHeader>
          <CardContent>
            <ReportTable
              columns={txnColumns}
              data={txns.data?.rows ?? []}
              loading={txns.isLoading}
              keyExtractor={(row) => row.id}
              emptyMessage="No capital transactions recorded yet."
            />
          </CardContent>
        </Card>
      </div>

      <AddOwnerDialog
        open={ownerDialogOpen}
        onOpenChange={setOwnerDialogOpen}
        onSaved={() => {
          setOwnerDialogOpen(false);
          invalidate();
        }}
      />
      <RecordTransactionDialog
        kind={txnDialog}
        owners={owners.data ?? []}
        onClose={() => setTxnDialog(null)}
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p
        className={`mt-1 text-xl font-semibold ${strong ? "text-emerald-700" : "text-slate-950"}`}
      >
        {formatCurrency(value)}
      </p>
    </div>
  );
}

function AddOwnerDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [ownershipPercent, setOwnershipPercent] = useState("");
  const [phone, setPhone] = useState("");

  const submit = async () => {
    await createEntityPromiseToast(
      () =>
        createOwnerApi({
          name,
          ownershipPercent: ownershipPercent === "" ? null : Number(ownershipPercent),
          phone: phone || null,
        }),
      { success: `Owner "${name}" added`, loading: "Adding owner…" },
    );
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add owner profile</DialogTitle>
          <DialogDescription>
            Ownership percent is descriptive — it never drives contribution math.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Ownership % (optional)</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={ownershipPercent}
                onChange={(e) => setOwnershipPercent(e.target.value)}
                placeholder="e.g. 50"
              />
            </div>
            <div className="space-y-1">
              <Label>Phone (optional)</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim()}>
            Save owner
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecordTransactionDialog({
  kind,
  owners,
  onClose,
}: {
  kind: TxnKind | null;
  owners: OwnerProfile[];
  onClose: () => void;
}) {
  const invalidate = useInvalidateFinance();
  const [ownerProfileId, setOwnerProfileId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [sourceOfFunds, setSourceOfFunds] = useState("");
  const [reference, setReference] = useState("");

  const isInvestment = kind === "investment";
  const submit = async () => {
    if (kind == null) return;
    try {
      await createEntityPromiseToast(
        () =>
          recordCapitalTransactionApi({
            ownerProfileId: Number(ownerProfileId),
            type: kind,
            amount: Number(amount),
            method,
            sourceOfFunds: isInvestment ? sourceOfFunds || null : null,
            reference: reference || null,
          }),
        {
          success: isInvestment ? "Investment recorded" : "Withdrawal recorded",
          loading: "Posting to the ledger…",
        },
      );
      invalidate();
      onClose();
    } catch {
      // toast shows the backend error
    }
  };

  return (
    <Dialog open={kind != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isInvestment ? "Record owner investment" : "Record owner withdrawal"}
          </DialogTitle>
          <DialogDescription>
            {isInvestment
              ? "Posted as DR cash / CR owner contributions."
              : "Posted as DR owner drawings / CR cash — never an expense."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Owner</Label>
            <Select value={ownerProfileId} onValueChange={setOwnerProfileId}>
              <SelectTrigger>
                <SelectValue placeholder="Select owner" />
              </SelectTrigger>
              <SelectContent>
                {owners.map((owner) => (
                  <SelectItem key={owner.id} value={String(owner.id)}>
                    {owner.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Amount (৳)</Label>
              <Input
                type="number"
                min={0}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="bank">Bank</SelectItem>
                  <SelectItem value="mfs">MFS wallet</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {isInvestment && (
            <div className="space-y-1">
              <Label>Source of funds (optional)</Label>
              <Input
                value={sourceOfFunds}
                onChange={(e) => setSourceOfFunds(e.target.value)}
                placeholder="e.g. Personal savings"
              />
            </div>
          )}
          <div className="space-y-1">
            <Label>Reference (optional)</Label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!ownerProfileId || !amount || Number(amount) <= 0}
          >
            <Coins className="size-4" /> Post
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
