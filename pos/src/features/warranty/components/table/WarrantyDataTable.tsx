import {
  useTable,
  type ColumnDef,
  type RowData,
} from "@tanstack/react-table";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { formatNumber } from "@/lib/format";
import { warrantyTableFeatures, type WarrantyTableFeatures } from "./warranty-table-features";

interface WarrantyDataTableProps<TData extends RowData> {
  columns: ColumnDef<WarrantyTableFeatures, TData>[];
  data: TData[];
  loading?: boolean | undefined;
  error?: string | null | undefined;
  emptyMessage?: string | undefined;
  /** Server-side pagination — the table renders exactly one page. */
  page?: number | undefined;
  pageSize?: number | undefined;
  total?: number | undefined;
  onPageChange?: ((page: number) => void) | undefined;
  onPageSizeChange?: ((pageSize: number) => void) | undefined;
  onRetry?: (() => void) | undefined;
}

const SKELETON_ROWS = 6;
const PAGE_SIZES = [10, 20, 25, 50];

/**
 * Server-paginated data table for the warranty feature (TanStack Table v9).
 * Sorting/filtering happens on the backend — the table renders exactly the
 * rows the current query returned.
 */
export function WarrantyDataTable<TData extends RowData>({
  columns,
  data,
  loading = false,
  error = null,
  emptyMessage = "No records found.",
  page = 1,
  pageSize = 20,
  total = 0,
  onPageChange,
  onPageSizeChange,
  onRetry,
}: WarrantyDataTableProps<TData>) {
  const table = useTable({
    features: warrantyTableFeatures,
    data,
    columns,
  });

  const totalPages = pageSize > 0 ? Math.max(Math.ceil(total / pageSize), 1) : 1;
  const totalColumns = columns.length;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-xs">
        <Table className="min-w-[860px]">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow
                key={headerGroup.id}
                className="border-b border-border bg-muted/50 hover:bg-muted/50"
              >
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                  >
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
              Array.from({ length: SKELETON_ROWS }).map((_, rowIndex) => (
                <TableRow key={`skeleton-${rowIndex}`} className="border-b border-border">
                  {columns.map((_, cellIndex) => (
                    <TableCell key={`skeleton-${rowIndex}-${cellIndex}`}>
                      <div className="h-4 animate-pulse rounded bg-muted" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : error ? (
              <TableRow>
                <TableCell colSpan={totalColumns} className="py-12 text-center">
                  <div className="mx-auto max-w-md space-y-2" role="alert">
                    <p className="text-sm font-medium text-destructive">
                      Unable to load data.
                    </p>
                    <p className="text-xs text-muted-foreground">{error}</p>
                    {onRetry && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onRetry}
                      >
                        Try again
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={totalColumns} className="py-6">
                  <EmptyState title={emptyMessage} className="border-0 bg-transparent py-8" />
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="border-b border-border transition-colors last:border-0 hover:bg-muted/40"
                >
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id} className="text-sm text-foreground">
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Server-side pagination bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <p className="text-xs text-muted-foreground">
          {loading
            ? "Loading…"
            : `${formatNumber(total)} record${total === 1 ? "" : "s"} · page ${page} of ${totalPages}`}
        </p>
        <div className="flex items-center gap-2">
          {onPageSizeChange && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Rows
              <select
                value={String(pageSize)}
                onChange={(event) => onPageSizeChange(Number(event.target.value))}
                className="h-7 cursor-pointer rounded-md border border-input bg-card px-1.5 text-xs text-foreground outline-none"
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
          )}
          {onPageChange && (
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => onPageChange(page - 1)}
                disabled={page <= 1}
              >
                <span className="sr-only">Previous page</span>
                <ChevronLeft />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => onPageChange(page + 1)}
                disabled={page >= totalPages}
              >
                <span className="sr-only">Next page</span>
                <ChevronRight />
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
