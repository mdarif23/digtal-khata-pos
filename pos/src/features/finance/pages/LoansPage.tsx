import { useState } from "react";
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
  createLoanApi,
  recordLoanRepaymentApi,
} from "../finance.api";
import {
  financeKeys,
  useInvalidateFinance,
  useLoanRepayments,
  useLoans,
} from "../hooks/useFinance";
import type { BusinessLoan } from "../finance.types";

/**
 * Loans: disbursement posts DR cash / CR 2080 (financing); repayments split
 * principal (DR 2080) from interest (DR 5090) — never conflated — and the
 * loan auto-closes when the principal is fully repaid.
 */

export function LoansPage() {
  const loans = useLoans();
  const invalidate = useInvalidateFinance();
  const [createOpen, setCreateOpen] = useState(false);
  const [repayLoan, setRepayLoan] = useState<BusinessLoan | null>(null);

  const columns: ReportColumn<BusinessLoan>[] = [
    { key: "lenderName", header: "Lender", render: (row) => <span className="font-medium">{row.lenderName}</span> },
    { key: "lenderType", header: "Type", render: (row) => <span className="capitalize">{row.lenderType}</span> },
    { key: "principal", header: "Principal", render: (row) => formatCurrency(row.principal) },
    { key: "principalRepaid", header: "Repaid", render: (row) => formatCurrency(row.principalRepaid ?? "0") },
    { key: "interestPaid", header: "Interest paid", render: (row) => formatCurrency(row.interestPaid ?? "0") },
    { key: "outstanding", header: "Outstanding", render: (row) => <strong>{formatCurrency(row.outstanding ?? "0")}</strong> },
    {
      key: "status",
      header: "Status",
      render: (row) => (
        <Badge
          variant="outline"
          className={
            row.status === "active"
              ? "text-xs text-sky-700"
              : row.status === "closed"
                ? "text-xs text-emerald-700"
                : "text-xs text-slate-500"
          }
        >
          {row.status.replace("_", " ")}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (row) =>
        row.status === "active" ? (
          <Button variant="outline" size="sm" onClick={() => setRepayLoan(row)}>
            Repay
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
            Finance &amp; Growth
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            Loans
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Principal repayment reduces the loan payable; interest is an expense —
            reported separately, never conflated.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Record Loan</Button>
      </header>

      <Card>
        <CardContent>
          <ReportTable
            columns={columns}
            data={loans.data ?? []}
            loading={loans.isLoading}
            keyExtractor={(row) => row.id}
            emptyMessage="No loans recorded."
          />
        </CardContent>
      </Card>

      <CreateLoanDialog open={createOpen} onOpenChange={setCreateOpen} />
      {repayLoan && (
        <RepayDialog
          loan={repayLoan}
          onClose={() => setRepayLoan(null)}
        />
      )}
    </div>
  );
}

function CreateLoanDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidateFinance();
  const [lenderType, setLenderType] = useState("bank");
  const [lenderName, setLenderName] = useState("");
  const [principal, setPrincipal] = useState("");
  const [interestRate, setInterestRate] = useState("");
  const [method, setMethod] = useState("cash");

  const submit = async () => {
    await createEntityPromiseToast(
      () =>
        createLoanApi({
          lenderType: lenderType as "bank" | "mfs" | "owner" | "other",
          lenderName,
          principal: Number(principal),
          interestRate: interestRate ? Number(interestRate) : null,
          method,
        }),
      { success: "Loan recorded — cash received", loading: "Posting disbursement…" },
    );
    invalidate();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record loan received</DialogTitle>
          <DialogDescription>Posted as DR cash / CR loans payable.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Lender type</Label>
              <Select value={lenderType} onValueChange={setLenderType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bank">Bank</SelectItem>
                  <SelectItem value="mfs">MFS</SelectItem>
                  <SelectItem value="owner">Owner</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Lender name</Label>
              <Input value={lenderName} onChange={(e) => setLenderName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Principal (৳)</Label>
              <Input
                type="number"
                min={0}
                value={principal}
                onChange={(e) => setPrincipal(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Interest rate %/yr (optional)</Label>
              <Input
                type="number"
                min={0}
                value={interestRate}
                onChange={(e) => setInterestRate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Received into</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="bank">Bank</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!lenderName || !principal}>
            Post
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RepayDialog({ loan, onClose }: { loan: BusinessLoan; onClose: () => void }) {
  const invalidate = useInvalidateFinance();
  const [principalAmount, setPrincipalAmount] = useState("");
  const [interestAmount, setInterestAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const repayments = useLoanRepayments(loan.id);

  const submit = async () => {
    await createEntityPromiseToast(
      () =>
        recordLoanRepaymentApi(loan.id, {
          principalAmount: Number(principalAmount),
          interestAmount: interestAmount ? Number(interestAmount) : 0,
          method,
        }),
      { success: "Repayment recorded", loading: "Posting split… " },
    );
    invalidate();
    onClose();
  };

  const repaymentColumns: ReportColumn<{
    id: number;
    paymentDate: string;
    principalAmount: string;
    interestAmount: string;
    totalAmount: string;
  }>[] = [
    { key: "paymentDate", header: "Date", render: (row) => row.paymentDate },
    { key: "principalAmount", header: "Principal", render: (row) => formatCurrency(row.principalAmount) },
    { key: "interestAmount", header: "Interest", render: (row) => formatCurrency(row.interestAmount) },
    { key: "totalAmount", header: "Total", render: (row) => formatCurrency(row.totalAmount) },
  ];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Repay {loan.lenderName}</DialogTitle>
          <DialogDescription>
            Outstanding {formatCurrency(loan.outstanding ?? "0")} · principal
            reduces the payable, interest posts to the interest expense account.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 items-end gap-2">
          <div className="space-y-1">
            <Label>Principal ৳</Label>
            <Input
              type="number"
              min={0}
              value={principalAmount}
              onChange={(e) => setPrincipalAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Interest ৳</Label>
            <Input
              type="number"
              min={0}
              value={interestAmount}
              onChange={(e) => setInterestAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>From</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="bank">Bank</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="max-h-40 overflow-y-auto">
          <ReportTable
            columns={repaymentColumns}
            data={repayments.data ?? []}
            loading={repayments.isLoading}
            keyExtractor={(row) => row.id}
            emptyMessage="No repayments yet."
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={submit} disabled={!principalAmount}>
            Post repayment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
