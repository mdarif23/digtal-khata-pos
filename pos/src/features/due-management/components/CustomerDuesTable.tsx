import { useMemo, useState } from "react";
import {
  type ColumnDef,
  type SortingState,
  useTable,
} from "@tanstack/react-table";
import {
  BookOpen,
  History,
  MessageSquare,
  MoreHorizontal,
  Receipt,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
import { DataTablePagination } from "@/features/products/components/ProductsPage/Table/data-table-pagination.js";
import { DataTableColumnHeader } from "@/features/products/components/ProductsPage/Table/data-table-column-header.js";
import {
  features,
  type DataTableFeatures,
} from "@/features/products/components/ProductsPage/Table/data-table-features.js";
import { formatCurrency, formatDate } from "@/lib/format";
import type { CustomerDueRow } from "../api/dueManagement.api";
import { statusLabel, statusTone } from "../lib/format";

/** Money columns render right-aligned with aligned digits. */
const MONEY_COLUMNS = new Set(["totalAmount", "paidAmount", "outstandingAmount"]);

export type CustomerRowActions = {
  onRecordPayment: (row: CustomerDueRow) => void;
  onViewPayments: (row: CustomerDueRow) => void;
  onOpenLedger: (row: CustomerDueRow) => void;
  onMessage: (row: CustomerDueRow) => void;
  onViewSale: (row: CustomerDueRow) => void;
};

function createColumns(
  actions: CustomerRowActions,
): ColumnDef<DataTableFeatures, CustomerDueRow>[] {
  return [
    {
      accessorKey: "customerName",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Customer" />
      ),
      cell: ({ row }) => (
        <div>
          <p className="font-medium">
            {row.original.customerName ?? "Walk-in customer"}
          </p>
          <p className="text-xs text-muted-foreground">
            {row.original.phone ?? "no phone"}
          </p>
        </div>
      ),
    },
    {
      accessorKey: "invoiceNumber",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Invoice" />
      ),
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.invoiceNumber}</span>
      ),
    },
    {
      accessorKey: "invoiceDate",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Date" />
      ),
      cell: ({ row }) => (
        <div>
          <p>{formatDate(row.original.invoiceDate)}</p>
          {row.original.isOverdue ? (
            <StatusBadge tone="danger" className="mt-1">
              Overdue
            </StatusBadge>
          ) : null}
        </div>
      ),
    },
    {
      accessorKey: "totalAmount",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Invoice total" />
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">{formatCurrency(row.original.totalAmount)}</span>
      ),
    },
    {
      accessorKey: "paidAmount",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Paid" />
      ),
      cell: ({ row }) => (
        <span className="tabular-nums text-success">
          {formatCurrency(row.original.paidAmount)}
        </span>
      ),
    },
    {
      accessorKey: "outstandingAmount",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Outstanding" />
      ),
      cell: ({ row }) => (
        <span className="font-semibold tabular-nums">
          {formatCurrency(row.original.outstandingAmount)}
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => (
        <StatusBadge tone={statusTone(row.original.status)}>
          {statusLabel(row.original.status)}
        </StatusBadge>
      ),
    },
    {
      id: "actions",
      enableHiding: false,
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => <RowActions row={row.original} actions={actions} />,
    },
  ];
}

function RowActions({
  row,
  actions,
}: {
  row: CustomerDueRow;
  actions: CustomerRowActions;
}) {
  const settled = row.outstandingAmount <= 0;
  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Actions for invoice ${row.invoiceNumber}`}
            >
              <MoreHorizontal />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={() => actions.onRecordPayment(row)} disabled={settled}>
            <Receipt />
            Record payment
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => actions.onViewPayments(row)}>
            <History />
            Payment history
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => actions.onOpenLedger(row)} disabled={row.customerId === null}>
            <BookOpen />
            Customer ledger
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => actions.onMessage(row)}>
            <MessageSquare />
            Send message
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => actions.onViewSale(row)}>
            <Search />
            View sale
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function CustomerDuesTable({
  rows,
  loading,
  isError,
  onRetry,
  actions,
  toolbar,
}: {
  rows: CustomerDueRow[];
  loading: boolean;
  isError: boolean;
  onRetry: () => void;
  actions: CustomerRowActions;
  toolbar: React.ReactNode;
}) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "outstandingAmount", desc: true },
  ]);

  const columns = useMemo(() => createColumns(actions), [actions]);

  const table = useTable({
    features,
    data: rows,
    columns,
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  });

  return (
    <div className="space-y-4">
      {toolbar}

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder ? null : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-32 text-center text-muted-foreground"
                  role="status"
                >
                  Loading dues…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-32 text-center">
                  <div className="space-y-2">
                    <p role="alert" className="text-sm text-destructive">
                      Could not load customer dues.
                    </p>
                    <Button variant="outline" size="sm" onClick={onRetry}>
                      Retry
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={
                        cell.column.id === "actions" ||
                        MONEY_COLUMNS.has(cell.column.id)
                          ? "text-right"
                          : undefined
                      }
                    >
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="p-0">
                  <EmptyState
                    icon={Receipt}
                    title="No invoices match these filters."
                    description="Try clearing a filter or widening the date range."
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <DataTablePagination table={table} showSelectedRowCount={false} />
    </div>
  );
}
