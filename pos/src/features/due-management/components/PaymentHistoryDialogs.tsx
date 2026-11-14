import {
  usePurchasePayments,
  useSalePayments,
} from "../hooks/useDueManagement";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { History } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";

function HistorySkeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-8 w-full" />
      ))}
    </div>
  );
}

function EmptyHistory() {
  return (
    <EmptyState
      icon={History}
      title="No payments recorded yet."
      description="Payments recorded against this document will appear here."
    />
  );
}

export function SalePaymentHistoryDialog({
  saleId,
  open,
  onOpenChange,
}: {
  saleId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const historyQuery = useSalePayments(open ? saleId : null);
  const payments = historyQuery.data?.payments ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Payment history — {historyQuery.data?.invoiceNumber ?? "invoice"}
          </DialogTitle>
          <DialogDescription>
            Every payment recorded against this invoice, newest first.
          </DialogDescription>
        </DialogHeader>
        {historyQuery.isLoading ? (
          <HistorySkeleton />
        ) : historyQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load payment history. Please try again.
          </p>
        ) : payments.length === 0 ? (
          <EmptyHistory />
        ) : (
          <div className="max-h-80 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((payment) => (
                  <TableRow key={payment.id}>
                    <TableCell>{formatDate(payment.paymentDate)}</TableCell>
                    <TableCell className="capitalize">
                      {payment.paymentMethod.replace("_", " ")}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {payment.reference ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatCurrency(payment.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function PurchasePaymentHistoryDialog({
  purchaseId,
  open,
  onOpenChange,
}: {
  purchaseId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const historyQuery = usePurchasePayments(open ? purchaseId : null);
  const payments = historyQuery.data?.payments ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Payment history —{" "}
            {historyQuery.data?.purchaseOrderNumber ?? "purchase"}
          </DialogTitle>
          <DialogDescription>
            Every payment made to the supplier for this purchase, newest first.
          </DialogDescription>
        </DialogHeader>
        {historyQuery.isLoading ? (
          <HistorySkeleton />
        ) : historyQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load payment history. Please try again.
          </p>
        ) : payments.length === 0 ? (
          <EmptyHistory />
        ) : (
          <div className="max-h-80 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((payment) => (
                  <TableRow key={payment.id}>
                    <TableCell>{formatDate(payment.paymentDate)}</TableCell>
                    <TableCell className="capitalize">
                      {payment.method.replace("_", " ")}
                    </TableCell>
                    <TableCell className="max-w-40 truncate text-xs">
                      {payment.notes ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatCurrency(payment.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
