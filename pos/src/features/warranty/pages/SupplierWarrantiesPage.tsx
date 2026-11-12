import { useEffect, useMemo, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { Link } from "react-router";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { usePermissions } from "@/hooks/usePermissions";
import { useSupplierWarrantiesList } from "../hooks/useSupplierWarranties";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { formatDate } from "@/features/reports/utils/reportUtils";
import { WarrantyDataTable } from "../components/table/WarrantyDataTable";
import { WarrantyStatusBadge } from "../components/WarrantyStatusBadge";
import { AddSupplierWarrantyDialog } from "../components/AddSupplierWarrantyDialog";
import { durationLabel } from "../lib/warranty-format";
import type { SupplierWarrantyRow } from "../types/warranty.types";
import type { WarrantyTableFeatures } from "../components/table/warranty-table-features";

const columnHelper = createColumnHelper<WarrantyTableFeatures, SupplierWarrantyRow>();

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "expiring", label: "Expiring soon" },
  { value: "expired", label: "Expired" },
  { value: "voided", label: "Voided" },
  { value: "exhausted", label: "Exhausted" },
] as const;

const DEFAULT_PAGE_SIZE = 20;

export function SupplierWarrantiesPage() {
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [addOpen, setAddOpen] = useState(false);

  const { hasPermission } = usePermissions();
  const debouncedSearch = useDebouncedValue(search.trim());
  const canManage = hasPermission("warranty.supplier.manage");

  const filters = useMemo(
    () => ({
      status,
      search: debouncedSearch || undefined,
      page,
      pageSize,
    }),
    [status, debouncedSearch, page, pageSize],
  );

  const query = useSupplierWarrantiesList(filters);

  useEffect(() => {
    if (query.isError) {
      toast.add({
        type: "error",
        title: "Could not load supplier warranties",
        description: getErrorMessage(query.error),
      });
    }
  }, [query.isError, query.error]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, status, pageSize]);

  const columns = useMemo(
    () => columnHelper.columns([
      columnHelper.display({
        id: "supplier",
        header: "Supplier",
        cell: ({ row }) => (
          <Link
            to={`/procurement/suppliers/${row.original.supplierId}`}
            className="font-medium text-emerald-700 hover:underline"
          >
            {row.original.supplierName}
          </Link>
        ),
      }),
      columnHelper.display({
        id: "product",
        header: "Product",
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium text-slate-900">
              {row.original.productName}
            </p>
            {row.original.variantOptionLabel ? (
              <p className="truncate text-xs text-slate-500">
                {row.original.variantOptionLabel}
              </p>
            ) : null}
          </div>
        ),
      }),
      columnHelper.display({
        id: "purchase",
        header: "Purchase",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-slate-600">
            #{row.original.purchaseId} / line {row.original.purchaseItemId}
          </span>
        ),
      }),
      columnHelper.display({
        id: "coverage",
        header: "Coverage",
        cell: ({ row }) => (
          <div className="text-xs">
            <p className="text-slate-700">
              {durationLabel(row.original.duration, row.original.durationUnit)}
            </p>
            <p className="text-slate-500">
              {formatDate(row.original.startDate)} → {formatDate(row.original.expiryDate)}
            </p>
          </div>
        ),
      }),
      columnHelper.display({
        id: "quantity",
        header: "Claimed / total",
        cell: ({ row }) => (
          <span className="text-slate-700">
            {row.original.claimedQuantity} / {row.original.quantity}
          </span>
        ),
      }),
      columnHelper.accessor("status", {
        id: "status",
        header: "Status",
        cell: ({ row }) => <WarrantyStatusBadge status={row.original.status} />,
      }),
      columnHelper.display({
        id: "terms",
        header: "Terms",
        cell: ({ row }) =>
          row.original.terms ? (
            <p className="max-w-xs truncate text-xs text-slate-500" title={row.original.terms}>
              {row.original.terms}
            </p>
          ) : (
            <span className="text-slate-400">—</span>
          ),
      }),
    ]),
    [],
  );

  return (
    <div className="space-y-5 p-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-col gap-3 text-xl sm:flex-row sm:items-center sm:justify-between">
            <span>Supplier Warranties</span>
            {canManage && (
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus aria-hidden="true" />
                Add supplier warranty
              </Button>
            )}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Warranty terms your suppliers committed to on purchased stock.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative w-full lg:max-w-sm">
              <Search
                className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search supplier, product…"
                aria-label="Search supplier warranties"
                className="pl-8"
              />
            </div>
            <Select value={status} onValueChange={(value) => setStatus(value ?? "all")}>
              <SelectTrigger className="lg:w-44" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <WarrantyDataTable
        columns={columns}
        data={query.data?.data ?? []}
        loading={query.isPending}
        error={query.isError ? getErrorMessage(query.error) : null}
        onRetry={query.refetch}
        emptyMessage="No supplier warranties registered yet."
        page={page}
        pageSize={pageSize}
        total={query.data?.meta.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      <AddSupplierWarrantyDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
