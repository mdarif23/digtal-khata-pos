import { useState } from "react";
import { BookOpen, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import {
  useCustomerLedger,
  useSupplierLedger,
} from "../hooks/useDueManagement";
import { formatCurrency, formatDate } from "@/lib/format";

const TYPE_LABELS: Record<string, string> = {
  invoice: "Sale invoice",
  payment: "Payment received",
  refund: "Refund / credit",
  purchase: "Purchase invoice",
  return: "Purchase return",
};

function LedgerTable({
  isLoading,
  isError,
  transactions,
}: {
  isLoading: boolean;
  isError: boolean;
  transactions: import("../api/dueManagement.api").LedgerTransaction[];
}) {
  if (isLoading) {
    return (
      <div className="space-y-2" aria-busy="true">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <p role="alert" className="py-6 text-center text-sm text-destructive">
        Could not load the ledger. Please try again.
      </p>
    );
  }
  if (transactions.length === 0) {
    return (
      <EmptyState
        icon={BookOpen}
        title="No transactions in the selected date range."
      />
    );
  }
  return (
    <div className="max-h-[420px] overflow-y-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead className="text-right">Debit</TableHead>
            <TableHead className="text-right">Credit</TableHead>
            <TableHead className="text-right">Balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {transactions.map((transaction, index) => (
            <TableRow key={`${transaction.type}-${transaction.relatedId ?? index}`}>
              <TableCell>{formatDate(transaction.transactionDate)}</TableCell>
              <TableCell>
                <span
                  className={
                    transaction.debit > 0
                      ? "font-medium text-destructive"
                      : "font-medium text-success"
                  }
                >
                  {TYPE_LABELS[transaction.type] ?? transaction.type}
                </span>
              </TableCell>
              <TableCell className="font-mono text-xs">
                {transaction.reference}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {transaction.debit > 0 ? formatCurrency(transaction.debit) : "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {transaction.credit > 0 ? formatCurrency(transaction.credit) : "—"}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {formatCurrency(transaction.runningBalance)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function LedgerTotals({
  openingBalance,
  totals,
}: {
  openingBalance: number;
  totals: { debit: number; credit: number; closing: number };
}) {
  return (
    <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm tabular-nums sm:grid-cols-4">
      <div>
        <p className="text-muted-foreground">Opening balance</p>
        <p className="font-semibold">{formatCurrency(openingBalance)}</p>
      </div>
      <div>
        <p className="text-muted-foreground">Total debit</p>
        <p className="font-semibold">{formatCurrency(totals.debit)}</p>
      </div>
      <div>
        <p className="text-muted-foreground">Total credit</p>
        <p className="font-semibold">{formatCurrency(totals.credit)}</p>
      </div>
      <div>
        <p className="text-muted-foreground">Closing balance</p>
        <p className="font-semibold">{formatCurrency(totals.closing)}</p>
      </div>
    </div>
  );
}

export function LedgerDialog({
  kind,
  partyId,
  partyName,
  open,
  onOpenChange,
}: {
  kind: "customer" | "supplier";
  partyId: number | null;
  partyName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const activeId = open ? partyId : null;

  const customerLedger = useCustomerLedger(
    kind === "customer" ? activeId : null,
    { from: from || undefined, to: to || undefined },
  );
  const supplierLedger = useSupplierLedger(
    kind === "supplier" ? activeId : null,
    { from: from || undefined, to: to || undefined },
  );

  const ledger = kind === "customer" ? customerLedger : supplierLedger;
  const transactions = ledger.data?.transactions ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {kind === "customer" ? "Customer" : "Supplier"} ledger — {partyName}
          </DialogTitle>
          <DialogDescription>
            {kind === "customer"
              ? "Charges (sales) are debits; payments and refunds received are credits. Built from actual transaction history."
              : "Purchases are debits; payments made and purchase returns are credits. Built from actual transaction history."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="ledger-from">From</Label>
            <Input
              id="ledger-from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ledger-to">To</Label>
            <Input
              id="ledger-to"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
          >
            Clear range
          </Button>
          <Button
            type="button"
            variant="outline"
            className="sm:ml-auto"
            disabled={ledger.isLoading}
            onClick={() => window.print()}
          >
            <Printer />
            Print
          </Button>
        </div>

        {ledger.data ? (
          <LedgerTotals
            openingBalance={ledger.data.openingBalance}
            totals={ledger.data.totals}
          />
        ) : null}

        <LedgerTable
          isLoading={ledger.isLoading}
          isError={ledger.isError}
          transactions={transactions}
        />
      </DialogContent>
    </Dialog>
  );
}
