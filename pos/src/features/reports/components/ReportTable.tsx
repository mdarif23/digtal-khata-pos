import React from "react";
import { ChevronDown, ChevronUp, ChevronsUpDown, Loader2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface ReportColumn<T> {
  key: string;
  header: string;
  render: (row: T, index: number) => React.ReactNode;
  sortable?: boolean;
  className?: string;
  headerClassName?: string;
}

interface ReportTableProps<T> {
  columns: ReportColumn<T>[];
  data: T[];
  loading?: boolean | undefined;
  error?: string | null | undefined;
  emptyMessage?: string | undefined;
  sortBy?: string | undefined;
  sortDir?: "asc" | "desc" | undefined;
  onSort?: ((key: string) => void) | undefined;
  keyExtractor: (row: T, index: number) => string | number;
  page?: number | undefined;
  limit?: number | undefined;
  total?: number | undefined;
  onPageChange?: ((page: number) => void) | undefined;
}

export function ReportTable<T>({
  columns,
  data,
  loading = false,
  error = null,
  emptyMessage = "No records found for the selected period.",
  sortBy,
  sortDir,
  onSort,
  keyExtractor,
  page = 1,
  limit = 50,
  total,
  onPageChange,
}: ReportTableProps<T>) {
  const totalPages = total !== undefined ? Math.ceil(total / limit) : undefined;

  const SortIcon = ({ colKey }: { colKey: string }) => {
    if (colKey !== sortBy) {
      return <ChevronsUpDown className="size-3.5 text-slate-300" />;
    }
    return sortDir === "asc" ? (
      <ChevronUp className="size-3.5 text-slate-900" />
    ) : (
      <ChevronDown className="size-3.5 text-slate-900" />
    );
  };

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-slate-200/90 bg-white shadow-xs">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50/75 hover:bg-slate-50/75 border-b border-slate-200">
              {columns.map((col) => (
                <TableHead
                  key={col.key}
                  className={`text-xs font-semibold uppercase tracking-wider text-slate-600 ${
                    col.headerClassName ?? ""
                  } ${
                    col.sortable && onSort
                      ? "cursor-pointer select-none hover:text-slate-900"
                      : ""
                  }`}
                  onClick={
                    col.sortable && onSort ? () => onSort(col.key) : undefined
                  }
                >
                  <span className="inline-flex items-center gap-1.5">
                    {col.header}
                    {col.sortable && <SortIcon colKey={col.key} />}
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="py-16 text-center"
                >
                  <div className="flex items-center justify-center gap-2 text-slate-500">
                    <Loader2 className="size-5 animate-spin text-emerald-600" />
                    <span className="text-sm font-medium">
                      Loading report data…
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ) : error ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="py-12 text-center"
                >
                  <div className="max-w-md mx-auto text-center space-y-1">
                    <p className="text-sm font-medium text-rose-600">
                      Error loading report
                    </p>
                    <p className="text-xs text-slate-500">{error}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="py-14 text-center"
                >
                  <p className="text-sm text-slate-400 font-medium">
                    {emptyMessage}
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              data.map((row, index) => (
                <TableRow
                  key={keyExtractor(row, index)}
                  className="hover:bg-slate-50/50 transition-colors border-b border-slate-100 last:border-0"
                >
                  {columns.map((col) => (
                    <TableCell
                      key={col.key}
                      className={`text-sm text-slate-700 ${col.className ?? ""}`}
                    >
                      {col.render(row, index)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination Bar */}
      {totalPages !== undefined && totalPages > 1 && onPageChange && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <p className="text-xs text-slate-500">
            Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total ?? 0)}{" "}
            of {(total ?? 0).toLocaleString()} records
          </p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
              className="inline-flex h-8 items-center px-2.5 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-700 disabled:opacity-40 hover:bg-slate-50 shadow-2xs"
            >
              Previous
            </button>
            <span className="px-2 text-xs font-medium text-slate-600">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
              className="inline-flex h-8 items-center px-2.5 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-700 disabled:opacity-40 hover:bg-slate-50 shadow-2xs"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

