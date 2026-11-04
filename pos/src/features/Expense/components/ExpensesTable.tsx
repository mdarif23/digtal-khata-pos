import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Eye,
  Pencil,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PermissionButton } from "@/components/common/PermissionGuard";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/features/reports/utils/reportUtils";
import { cn } from "@/lib/utils";
import { ExpenseDialog } from "./ExpenseDialog";
import { ExpenseDetailsDrawer } from "./ExpenseDetailsDrawer";
import type {
  ExpenseCategory,
  ExpenseListMeta,
  ExpensePaymentStatus,
  ExpenseRecord,
} from "../expense.type";
import { useVoidExpense } from "../hooks/useExpenses";

const dateFormatter = new Intl.DateTimeFormat("en-BD", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const STATUS_STYLES: Record<ExpensePaymentStatus, string> = {
  paid: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-400",
  partial: "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-400",
  unpaid: "bg-destructive/10 text-destructive border-destructive/30",
};

const STATUS_LABELS: Record<ExpensePaymentStatus, string> = {
  paid: "Paid",
  partial: "Partial",
  unpaid: "Unpaid",
};

export const EXPENSE_SORT_OPTIONS = [
  { field: "expense_date", label: "Date" },
  { field: "title", label: "Expense" },
  { field: "amount", label: "Amount" },
  { field: "payment_status", label: "Status" },
] as const;

type SortField = (typeof EXPENSE_SORT_OPTIONS)[number]["field"];

const COLUMNS = [
  { key: "date", label: "Date", alwaysVisible: true },
  { key: "title", label: "Expense", alwaysVisible: true },
  { key: "category", label: "Category", alwaysVisible: false },
  { key: "payee", label: "Payee", alwaysVisible: false },
  { key: "location", label: "Location", alwaysVisible: false },
  { key: "method", label: "Method", alwaysVisible: false },
  { key: "amount", label: "Total", alwaysVisible: true },
  { key: "paid", label: "Paid", alwaysVisible: false },
  { key: "due", label: "Due", alwaysVisible: false },
  { key: "status", label: "Status", alwaysVisible: true },
  { key: "actions", label: "Actions", alwaysVisible: true },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

interface ExpensesTableProps {
  expenses: ExpenseRecord[];
  meta: ExpenseListMeta | undefined;
  categories: ExpenseCategory[];
  loading: boolean;
  sortField: SortField;
  sortDir: "asc" | "desc";
  onSortChange: (field: SortField) => void;
  onPageChange: (page: number) => void;
}

export function ExpensesTable({
  expenses,
  meta,
  categories,
  loading,
  sortField,
  sortDir,
  onSortChange,
  onPageChange,
}: ExpensesTableProps) {
  const voidExpense = useVoidExpense();
  const [detailId, setDetailId] = useState<number | null>(null);
  const [voidTarget, setVoidTarget] = useState<ExpenseRecord | null>(null);
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<ColumnKey>>(
    new Set(["method", "location"]),
  );

  const visible = (key: ColumnKey) => !hiddenColumns.has(key);
  const colCount = COLUMNS.filter((c) => visible(c.key)).length;

  function toggleColumn(key: ColumnKey) {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function renderSortHeader(field: SortField, label: string) {
    const active = sortField === field;
    const Icon = !active ? ArrowUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 h-7 gap-1 text-xs font-medium"
        onClick={() => onSortChange(field)}
        aria-label={`Sort by ${label}`}
      >
        {label}
        <Icon className="size-3.5" />
      </Button>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" variant="outline" size="sm">
                <Columns3 />
                Columns
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {COLUMNS.filter((c) => !c.alwaysVisible).map((column) => (
              <DropdownMenuCheckboxItem
                key={column.key}
                checked={visible(column.key)}
                onCheckedChange={() => toggleColumn(column.key)}
              >
                {column.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              {visible("date") ? (
                <TableHead>{renderSortHeader("expense_date", "Date")}</TableHead>
              ) : null}
              {visible("title") ? (
                <TableHead>{renderSortHeader("title", "Expense")}</TableHead>
              ) : null}
              {visible("category") ? <TableHead>Category</TableHead> : null}
              {visible("payee") ? <TableHead>Payee</TableHead> : null}
              {visible("location") ? <TableHead>Location</TableHead> : null}
              {visible("method") ? <TableHead>Method</TableHead> : null}
              {visible("amount") ? (
                <TableHead className="text-right">
                  {renderSortHeader("amount", "Total")}
                </TableHead>
              ) : null}
              {visible("paid") ? (
                <TableHead className="text-right">Paid</TableHead>
              ) : null}
              {visible("due") ? (
                <TableHead className="text-right">Due</TableHead>
              ) : null}
              {visible("status") ? (
                <TableHead>{renderSortHeader("payment_status", "Status")}</TableHead>
              ) : null}
              {visible("actions") ? (
                <TableHead className="text-right">Actions</TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 6 }).map((_, index) => (
                <TableRow key={`skeleton-${String(index)}`}>
                  <TableCell colSpan={colCount} className="h-12">
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : expenses.length ? (
              expenses.map((expense) => {
                const amount = Number(expense.amount) || 0;
                const paid = Number(expense.paidAmount) || 0;
                const due = Math.round((amount - paid) * 100) / 100;
                return (
                  <TableRow key={expense.id} className="group">
                    {visible("date") ? (
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {dateFormatter.format(
                          new Date(`${expense.expenseDate}T00:00:00Z`),
                        )}
                      </TableCell>
                    ) : null}
                    {visible("title") ? (
                      <TableCell className="min-w-48 whitespace-normal">
                        <div className="font-medium">{expense.title}</div>
                        {expense.note ? (
                          <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                            {expense.note}
                          </div>
                        ) : null}
                      </TableCell>
                    ) : null}
                    {visible("category") ? (
                      <TableCell>{expense.categoryName ?? "Uncategorized"}</TableCell>
                    ) : null}
                    {visible("payee") ? (
                      <TableCell className="max-w-36 truncate">
                        {expense.payee || "—"}
                      </TableCell>
                    ) : null}
                    {visible("location") ? (
                      <TableCell className="max-w-36 truncate">
                        {expense.locationName ?? "—"}
                      </TableCell>
                    ) : null}
                    {visible("method") ? (
                      <TableCell>
                        {expense.paymentMethod ? (
                          <Badge variant="secondary">{expense.paymentMethod}</Badge>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    ) : null}
                    {visible("amount") ? (
                      <TableCell className="text-right font-semibold tabular-nums">
                        {formatCurrency(amount)}
                      </TableCell>
                    ) : null}
                    {visible("paid") ? (
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatCurrency(paid)}
                      </TableCell>
                    ) : null}
                    {visible("due") ? (
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          due > 0 && "font-medium text-destructive",
                        )}
                      >
                        {due > 0 ? formatCurrency(due) : "—"}
                      </TableCell>
                    ) : null}
                    {visible("status") ? (
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={STATUS_STYLES[expense.paymentStatus]}
                        >
                          {STATUS_LABELS[expense.paymentStatus]}
                        </Badge>
                      </TableCell>
                    ) : null}
                    {visible("actions") ? (
                      <TableCell>
                        <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`View ${expense.title}`}
                            onClick={() => setDetailId(expense.id)}
                          >
                            <Eye />
                          </Button>
                          <ExpenseDialog
                            categories={categories}
                            expense={expense}
                            trigger={
                              <PermissionButton
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                permission="expenses.edit"
                                aria-label={`Edit ${expense.title}`}
                              >
                                <Pencil />
                              </PermissionButton>
                            }
                          />
                          <PermissionButton
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            permission="expenses.delete"
                            aria-label={`Delete ${expense.title}`}
                            onClick={() => setVoidTarget(expense)}
                          >
                            <Trash2 className="text-destructive" />
                          </PermissionButton>
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell
                  colSpan={colCount}
                  className="h-28 text-center text-muted-foreground"
                >
                  No expenses match your filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {meta
            ? `${meta.total} expense${meta.total === 1 ? "" : "s"} · page ${meta.page} of ${meta.totalPages}`
            : "—"}
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!meta || meta.page <= 1 || loading}
            onClick={() => onPageChange((meta?.page ?? 1) - 1)}
          >
            <ChevronLeft />
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              !meta || meta.page >= meta.totalPages || loading
            }
            onClick={() => onPageChange((meta?.page ?? 1) + 1)}
          >
            Next
            <ChevronRight />
          </Button>
        </div>
      </div>

      <ExpenseDetailsDrawer
        expenseId={detailId ?? 0}
        open={detailId !== null}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      />

      <ConfirmDeleteDialog
        open={voidTarget !== null}
        onOpenChange={(open) => {
          if (!open) setVoidTarget(null);
        }}
        title="Delete this expense?"
        description={`"${voidTarget?.title ?? ""}" will be removed from your active records. Past reports stay reproducible because the record is retained internally.`}
        entityName="Expense"
        onConfirm={async () => {
          if (!voidTarget) return;
          await voidExpense.mutateAsync({ id: voidTarget.id });
          setVoidTarget(null);
        }}
      />
    </div>
  );
}
