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
      <div className="overflow-x-auto rounded-xl border border-slate-200/90 bg-white shadow-xs">
        <Table className="min-w-[860px]">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow
                key={headerGroup.id}
                className="bg-slate-50/75 hover:bg-slate-50/75 border-b border-slate-200"
              >
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="text-xs font-semibold uppercase tracking-wider text-slate-600"
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
                <TableRow key={`skeleton-${rowIndex}`} className="border-b border-slate-100">
                  {columns.map((_, cellIndex) => (
                    <TableCell key={`skeleton-${rowIndex}-${cellIndex}`}>
                      <div className="h-4 animate-pulse rounded bg-slate-100" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : error ? (
              <TableRow>
                <TableCell colSpan={totalColumns} className="py-12 text-center">
                  <div className="mx-auto max-w-md space-y-2" role="alert">
                    <p className="text-sm font-medium text-rose-600">
                      Unable to load data.
                    </p>
                    <p className="text-xs text-slate-500">{error}</p>
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
                <TableCell colSpan={totalColumns} className="py-14 text-center">
                  <p className="text-sm font-medium text-slate-400">
                    {emptyMessage}
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="hover:bg-slate-50/50 transition-colors border-b border-slate-100 last:border-0"
                >
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id} className="text-sm text-slate-700">
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
        <p className="text-xs text-slate-500">
          {loading
            ? "Loading…"
            : `${total.toLocaleString()} record${total === 1 ? "" : "s"} · page ${page} of ${totalPages}`}
        </p>
        <div className="flex items-center gap-2">
          {onPageSizeChange && (
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              Rows
              <select
                value={String(pageSize)}
                onChange={(event) => onPageSizeChange(Number(event.target.value))}
                className="h-7 cursor-pointer rounded-md border border-slate-200 bg-white px-1.5 text-xs text-slate-700 outline-none"
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
