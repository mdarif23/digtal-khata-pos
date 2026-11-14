import { useMemo, useState } from "react";
import {
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type SortingState,
  useTable,
} from "@tanstack/react-table";
import { Eye, RotateCcw, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DataTablePagination } from "@/features/products/components/ProductsPage/Table/data-table-pagination.js";
import { DataTableViewOptions } from "@/features/products/components/ProductsPage/Table/data-table-view-options.js";
import {
  features,
  type DataTableFeatures,
} from "@/features/products/components/ProductsPage/Table/data-table-features.js";
import { DataTableColumnHeader } from "@/features/products/components/ProductsPage/Table/data-table-column-header.js";
import type { AllSoldProduct } from "../../types/sales.types.js";

import { formatCurrency as currencyFormatter } from "@/lib/format";

function createColumns(
  onViewSale: (id: number) => void,
  onRefundSale: (sale: AllSoldProduct) => void,
  busySaleId: number | null,
  onPrintSale: (saleId: number) => Promise<void>,
): ColumnDef<DataTableFeatures, AllSoldProduct>[] {
  return [
    {
      accessorKey: "id",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Invoice" />
      ),
      cell: ({ row }) => (
        <span className="font-medium">{row.original.invoiceNumber}</span>
      ),
    },
    {
      accessorKey: "createdAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Date & time" />
      ),
      cell: ({ row }) => {
        const date = new Date(row.original.createdAt ?? "");
        return Number.isNaN(date.getTime())
          ? "Invalid date"
          : date.toLocaleString();
      },
    },
    {
      accessorFn: (sale) => sale.items.length,
      id: "products",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Products" />
      ),
      cell: ({ row }) => row.original.items.length,
    },
    {
      accessorKey: "totalQuantity",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Units" />
      ),
      cell: ({ row }) => row.original.totalQuantity,
    },
    {
      accessorKey: "totalAmount",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Total" />
      ),
      cell: ({ row }) => (
        <span className="font-medium">
          {currencyFormatter(row.original.totalAmount)}
        </span>
      ),
    },
    {
      id: "status",
      accessorFn: (sale) => {
        const allReturned = sale.items.every(
          (item) => item.returnedQuantity >= item.soldQuantity,
        );
        const someReturned = sale.items.some(
          (item) => item.returnedQuantity > 0,
        );
        return allReturned
          ? "refunded"
          : someReturned
            ? "partial_return"
            : sale.paymentStatus;
      },
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => {
        const allReturned = row.original.items.every(
          (item) => item.returnedQuantity >= item.soldQuantity,
        );
        const someReturned = row.original.items.some(
          (item) => item.returnedQuantity > 0,
        );
        const status = allReturned
          ? "Refunded"
          : someReturned
            ? "Partial return"
            : row.original.paymentStatus;
        return (
          <Badge variant={allReturned ? "destructive" : "outline"}>
            {status}
          </Badge>
        );
      },
    },
    {
      id: "actions",
      enableHiding: false,
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => (
        <div className="flex justify-end gap-2">
          {onPrintSale && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPrintSale(row.original.id)}
              title="Print receipt"
            >
              <Printer className="size-4" />
              Receipt
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onViewSale(row.original.id)}
          >
            <Eye />
            Details
          </Button>
          <Button
            variant="warning"
            size="sm"
            disabled={
              busySaleId !== null ||
              row.original.items.every(
                (item) => item.returnedQuantity >= item.soldQuantity,
              )
            }
            onClick={() => onRefundSale(row.original)}
            aria-label={`Refund sale ${row.original.id}`}
          >
            <RotateCcw />
            Refund
          </Button>
        </div>
      ),
    },
  ];
}

export function SalesDataTable({
  data,
  loading,
  onViewSale,
  onRefundSale,
  busySaleId,
  onPrintSale,
}: {
  data: AllSoldProduct[];
  loading: boolean;
  onViewSale: (id: number) => void;
  onRefundSale: (sale: AllSoldProduct) => void;
  busySaleId: number | null;
  onPrintSale: (saleId: number) => Promise<void>;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] =
    useState<ColumnVisibilityState>({});
  const [rowSelection, setRowSelection] = useState({});
  const columns = useMemo(
    () => createColumns(onViewSale, onRefundSale, busySaleId, onPrintSale),
    [busySaleId, onRefundSale, onViewSale, onPrintSale],
  );
  const table = useTable({
    features,
    data,
    columns,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <DataTableViewOptions table={table} />
      </div>
      <div className="overflow-x-auto rounded-md border">
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
            {table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      onClick={
                        cell.column.id === "actions"
                          ? (event) => event.stopPropagation()
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
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  {loading ? "Loading sales..." : "No sales found."}
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
