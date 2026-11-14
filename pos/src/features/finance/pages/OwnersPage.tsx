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
import { StatusBadge } from "@/components/common/StatusBadge";
import { SummaryCard } from "@/components/common/SummaryCard";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { formatCurrency } from "@/lib/format";
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
        <StatusBadge
          tone={
            row.type === "investment"
              ? "success"
              : row.type === "distribution"
                ? "primary"
                : "warning"
          }
        >
          {row.type}
        </StatusBadge>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      render: (row) => <span className="tabular-nums">{formatCurrency(row.amount)}</span>,
      className: "text-right tabular-nums",
      headerClassName: "text-right",
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
    <PageContainer>
      <PageHeader
        title="Owner Capital"
        description="Investments, withdrawals and distributions — every movement is GL-posted (contributions → 3010, drawings → 3020)."
        actions={
          <>
            <Button variant="outline" onClick={() => setTxnDialog("withdrawal")}>
              <ArrowDownRight className="size-4" /> Record Withdrawal
            </Button>
            <Button onClick={() => setTxnDialog("investment")}>
              <ArrowUpRight className="size-4" /> Record Investment
            </Button>
          </>
        }
      />

      {summary.data && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <SummaryCard
            title="Contributed"
            value={formatCurrency(summary.data.totals.contributed)}
          />
          <SummaryCard
            title="Returned"
            value={formatCurrency(summary.data.totals.returned)}
          />
          <SummaryCard
            title="Distributed"
            value={formatCurrency(summary.data.totals.distributed)}
          />
          <SummaryCard
            title="Position"
            value={formatCurrency(summary.data.totals.position)}
            valueClassName="text-success"
          />
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
                className="flex items-center justify-between rounded-xl border px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{owner.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {owner.ownershipPercent != null
                      ? `${Number(owner.ownershipPercent)}% ownership`
                      : "Owner"}{" "}
                    · in {formatCurrency(owner.totals?.invested ?? "0")}
                  </p>
                </div>
                <Badge variant="outline" className="shrink-0 text-xs tabular-nums">
                  {formatCurrency(owner.capitalPosition ?? "0")}
                </Badge>
              </div>
            ))}
            {owners.data?.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">
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
    </PageContainer>
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
      <DialogContent className="sm:max-w-md">
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
      <DialogContent className="sm:max-w-md">
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
