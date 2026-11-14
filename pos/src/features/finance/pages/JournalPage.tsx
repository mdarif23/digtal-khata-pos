import { useState } from "react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/common/StatusBadge";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  createJournalEntryApi,
  getAccountsApi,
  reverseJournalEntryApi,
} from "../finance.api";
import { useInvalidateFinance } from "../hooks/useFinance";
import {
  financeKeys,
  useJournalEntries,
  useJournalEntry,
  usePeriods,
} from "../hooks/useFinance";
import { useQuery } from "@tanstack/react-query";
import type { FinanceAccount, JournalEntry } from "../finance.types";

/**
 * Journal & Periods: the accountant-facing view of the general ledger.
 * Manual drafts → post; posted entries reverse (never edit); periods
 * close/reopen.
 */

interface ManualLine {
  accountCode: string;
  debit: string;
  credit: string;
  description: string;
}

export function JournalPage() {
  const [filters, setFilters] = useState<{
    status?: string;
    sourceType?: string;
    dateFrom?: string;
    dateTo?: string;
    page: number;
    pageSize: number;
  }>({ page: 1, pageSize: 25 });
  const entries = useJournalEntries(filters);
  const periods = usePeriods();
  const invalidate = useInvalidateFinance();
  const accounts = useQuery({
    queryKey: financeKeys.accounts(),
    queryFn: getAccountsApi,
  });
  const [detailId, setDetailId] = useState<number | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [reverseId, setReverseId] = useState<number | null>(null);

  return (
    <PageContainer>
      <PageHeader
        title="Journal & Periods"
        description="Posted entries are immutable — corrections are reversals. Replays of a posting hook can never double-post (idempotency per source event)."
        actions={<Button onClick={() => setManualOpen(true)}>New manual entry</Button>}
      />

      <div className="grid gap-4 lg:grid-cols-4">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Accounting periods</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {periods.isLoading ? (
              <p className="py-2 text-xs text-muted-foreground">Loading periods…</p>
            ) : (periods.data ?? []).length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">
                No accounting periods yet — one is created with the first posted entry.
              </p>
            ) : (periods.data ?? []).slice(0, 8).map((period) => (
              <div
                key={period.id}
                className="flex items-center justify-between rounded-xl border px-3 py-2 text-sm"
              >
                <span>{period.periodStart.slice(0, 7)}</span>
                <div className="flex items-center gap-1.5">
                  <StatusBadge tone={period.status === "open" ? "success" : "neutral"}>
                    {period.status}
                  </StatusBadge>
                  {period.status === "open" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={async () => {
                        await createEntityPromiseToast(
                          () => import("../finance.api").then((m) => m.closePeriodApi(period.id)),
                          { success: "Period closed", loading: "Closing…" },
                        );
                        invalidate();
                      }}
                    >
                      Close
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={async () => {
                        await createEntityPromiseToast(
                          () => import("../finance.api").then((m) => m.reopenPeriodApi(period.id)),
                          { success: "Period reopened", loading: "Reopening…" },
                        );
                        invalidate();
                      }}
                    >
                      Reopen
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader className="flex-row items-center justify-between pb-3">
            <CardTitle className="text-base">Journal entries</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={filters.status ?? "all"}
                onValueChange={(value) =>
                  setFilters((prev) => ({
                    ...prev,
                    status: value === "all" ? undefined : value,
                    page: 1,
                  }))
                }
              >
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="posted">Posted</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="reversed">Reversed</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="date"
                className="w-36"
                value={filters.dateFrom ?? ""}
                onChange={(e) =>
                  setFilters((prev) => ({ ...prev, dateFrom: e.target.value, page: 1 }))
                }
              />
              <Input
                type="date"
                className="w-36"
                value={filters.dateTo ?? ""}
                onChange={(e) =>
                  setFilters((prev) => ({ ...prev, dateTo: e.target.value, page: 1 }))
                }
              />
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-2xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Entry</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Memo</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(entries.data?.rows ?? []).map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-mono text-xs">{entry.entryNo}</TableCell>
                      <TableCell>{formatDate(entry.entryDate)}</TableCell>
                      <TableCell className="capitalize">
                        {entry.sourceType?.replace(/_/g, " ") ?? "manual"}
                      </TableCell>
                      <TableCell className="max-w-56 truncate text-muted-foreground">
                        {entry.memo ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(entry.totalDebit ?? "0")}
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          tone={
                            entry.status === "posted"
                              ? "success"
                              : entry.status === "reversed"
                                ? "neutral"
                                : "warning"
                          }
                        >
                          {entry.status}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setDetailId(entry.id)}
                          >
                            Lines
                          </Button>
                          {entry.status === "posted" && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setReverseId(entry.id)}
                            >
                              Reverse
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {detailId != null && (
        <EntryDetailDialog id={detailId} onClose={() => setDetailId(null)} />
      )}
      {reverseId != null && (
        <ReverseDialog
          id={reverseId}
          onClose={() => setReverseId(null)}
        />
      )}
      <ManualEntryDialog
        open={manualOpen}
        onOpenChange={setManualOpen}
        accounts={accounts.data ?? []}
      />
    </PageContainer>
  );
}

function EntryDetailDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const entry = useJournalEntry(id);
  const lines = entry.data?.lines ?? [];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {entry.data?.entryNo}
            {entry.data?.status && (
              <StatusBadge
                tone={
                  entry.data.status === "posted"
                    ? "success"
                    : entry.data.status === "reversed"
                      ? "neutral"
                      : "warning"
                }
              >
                {entry.data.status}
              </StatusBadge>
            )}
          </DialogTitle>
          <DialogDescription>
            {formatDate(entry.data?.entryDate)} ·{" "}
            {entry.data?.sourceType?.replace(/_/g, " ") ?? "manual"} ·{" "}
            {entry.data?.memo ?? ""}
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell>
                    <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                      {line.accountCode}
                    </span>
                    {line.accountName}
                  </TableCell>
                  <TableCell className="max-w-56 truncate text-muted-foreground">
                    {line.description ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(line.debit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(line.credit)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReverseDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const invalidate = useInvalidateFinance();
  const [reason, setReason] = useState("");
  const submit = async () => {
    await createEntityPromiseToast(
      () => reverseJournalEntryApi(id, reason),
      { success: "Reversal posted", loading: "Posting reversal…" },
    );
    invalidate();
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reverse entry</DialogTitle>
          <DialogDescription>
            A balanced counter-entry is posted and the original is marked
            reversed — posted entries are never edited or deleted.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label>Reason</Label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Duplicate posting"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={reason.trim().length < 3}>
            Post reversal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManualEntryDialog({
  open,
  onOpenChange,
  accounts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: FinanceAccount[];
}) {
  const invalidate = useInvalidateFinance();
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<ManualLine[]>([
    { accountCode: "", debit: "", credit: "", description: "" },
    { accountCode: "", debit: "", credit: "", description: "" },
  ]);
  const [status, setStatus] = useState<"draft" | "posted">("posted");

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanced = Math.round(totalDebit * 100) === Math.round(totalCredit * 100) && totalDebit > 0;

  const submit = async () => {
    await createEntityPromiseToast(
      () =>
        createJournalEntryApi({
          entryDate,
          memo: memo || null,
          status,
          lines: lines
            .filter((l) => l.accountCode)
            // The backend rejects a line without an amount ("exactly one of
            // debit/credit > 0") — drop empty rows instead of a raw 400.
            .filter((l) => (Number(l.debit) || 0) > 0 || (Number(l.credit) || 0) > 0)
            .map((l) => ({
              accountCode: l.accountCode,
              debit: Number(l.debit) || undefined,
              credit: Number(l.credit) || undefined,
              description: l.description || null,
            })),
        }),
      { success: "Journal entry created", loading: "Posting…" },
    );
    invalidate();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Manual journal entry</DialogTitle>
          <DialogDescription>
            Debits must equal credits. System-generated entries (sales, payroll,
            …) post automatically — manual entries are for adjustments and
            corrections outside those flows.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>Memo</Label>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Lines</Label>
            {lines.map((line, index) => (
              <div key={index} className="grid grid-cols-12 gap-2">
                <div className="col-span-4">
                  <Select
                    value={line.accountCode}
                    onValueChange={(value) =>
                      setLines((prev) =>
                        prev.map((l, i) => (i === index ? { ...l, accountCode: value } : l)),
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Account" />
                    </SelectTrigger>
                    <SelectContent>
                      {(accounts ?? []).map((account) => (
                        <SelectItem key={account.id} value={account.code}>
                          {account.code} · {account.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-3">
                  <Input
                    type="number"
                    min={0}
                    placeholder="Debit ৳"
                    value={line.debit}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((l, i) =>
                          i === index ? { ...l, debit: e.target.value, credit: "" } : l,
                        ),
                      )
                    }
                  />
                </div>
                <div className="col-span-3">
                  <Input
                    type="number"
                    min={0}
                    placeholder="Credit ৳"
                    value={line.credit}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((l, i) =>
                          i === index ? { ...l, credit: e.target.value, debit: "" } : l,
                        ),
                      )
                    }
                  />
                </div>
                <div className="col-span-2">
                  <Input
                    placeholder="Note"
                    value={line.description}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((l, i) =>
                          i === index ? { ...l, description: e.target.value } : l,
                        ),
                      )
                    }
                  />
                </div>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setLines((prev) => [
                  ...prev,
                  { accountCode: "", debit: "", credit: "", description: "" },
                ])
              }
            >
              Add line
            </Button>
          </div>
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as "draft" | "posted")}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="posted">Post immediately</SelectItem>
                  <SelectItem value="draft">Save as draft</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <span
              className={
                balanced
                  ? "font-medium text-success tabular-nums"
                  : "font-medium text-warning tabular-nums"
              }
            >
              Debits {formatCurrency(totalDebit)} · Credits {formatCurrency(totalCredit)}
              {balanced ? " ✓" : ""}
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!balanced}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


