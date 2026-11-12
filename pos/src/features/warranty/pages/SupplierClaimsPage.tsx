import { useEffect, useMemo, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { Link } from "react-router";
import { FileText, Search } from "lucide-react";
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
import { useSupplierClaimsList } from "../hooks/useSupplierWarranties";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { formatCurrency, formatDateTime } from "@/features/reports/utils/reportUtils";
import { WarrantyDataTable } from "../components/table/WarrantyDataTable";
import { WarrantyStatusBadge } from "../components/WarrantyStatusBadge";
import { SUPPLIER_CLAIM_STATUS_OPTIONS } from "../lib/warranty-format";
import type { SupplierWarrantyClaimRow } from "../types/warranty.types";
import type { WarrantyTableFeatures } from "../components/table/warranty-table-features";

const columnHelper = createColumnHelper<WarrantyTableFeatures, SupplierWarrantyClaimRow>();

const DEFAULT_PAGE_SIZE = 20;

export function SupplierClaimsPage() {
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const debouncedSearch = useDebouncedValue(search.trim());

  const filters = useMemo(
    () => ({
      status,
      search: debouncedSearch || undefined,
      page,
      pageSize,
    }),
    [status, debouncedSearch, page, pageSize],
  );

  const query = useSupplierClaimsList(filters);

  useEffect(() => {
    if (query.isError) {
      toast.add({
        type: "error",
        title: "Could not load supplier claims",
        description: getErrorMessage(query.error),
      });
    }
  }, [query.isError, query.error]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, status, pageSize]);

  const columns = useMemo(
    () => columnHelper.columns([
      columnHelper.accessor("claimNumber", {
        id: "claimNumber",
        header: "Claim #",
        cell: ({ row }) => (
          <Link
            to={`/warranty/supplier-claims/${row.original.id}`}
            className="font-mono text-sm font-semibold text-emerald-700 hover:underline"
          >
            {row.original.claimNumber}
          </Link>
        ),
      }),
      columnHelper.accessor("status", {
        id: "status",
        header: "Status",
        cell: ({ row }) => <WarrantyStatusBadge status={row.original.status} />,
      }),
      columnHelper.accessor("supplierName", {
        id: "supplier",
        header: "Supplier",
        cell: ({ row }) => (
          <span className="text-slate-800">{row.original.supplierName}</span>
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
      columnHelper.accessor("defectiveQuantity", {
        id: "defective",
        header: "Defective",
        cell: ({ row }) => <span className="text-slate-700">{row.original.defectiveQuantity}</span>,
      }),
      columnHelper.accessor("replacementQuantity", {
        id: "replacement",
        header: "Replaced",
        cell: ({ row }) => <span className="text-slate-700">{row.original.replacementQuantity}</span>,
      }),
      columnHelper.accessor("recoveryAmount", {
        id: "recovery",
        header: "Recovered",
        cell: ({ row }) => formatCurrency(row.original.recoveryAmount),
      }),
      columnHelper.accessor("costAmount", {
        id: "cost",
        header: "Shop cost",
        cell: ({ row }) => formatCurrency(row.original.costAmount),
      }),
      columnHelper.accessor("createdAt", {
        id: "createdAt",
        header: "Filed",
        cell: ({ row }) => (
          <span className="text-xs whitespace-nowrap text-slate-500">
            {formatDateTime(row.original.createdAt)}
          </span>
        ),
      }),
      columnHelper.display({
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <Button
            render={<Link to={`/warranty/supplier-claims/${row.original.id}`} />}
            variant="ghost"
            size="sm"
          >
            <FileText aria-hidden="true" />
            View
          </Button>
        ),
      }),
    ]),
    [],
  );

  return (
    <div className="space-y-5 p-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Supplier Claims</CardTitle>
          <p className="text-sm text-muted-foreground">
            Defect claims pushed back to your suppliers, and what they returned.
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
                placeholder="Search claim, supplier, product…"
                aria-label="Search supplier claims"
                className="pl-8"
              />
            </div>
            <Select value={status} onValueChange={(value) => setStatus(value ?? "all")}>
              <SelectTrigger className="lg:w-52" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPLIER_CLAIM_STATUS_OPTIONS.map((option) => (
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
        emptyMessage="No supplier claims match this view."
        page={page}
        pageSize={pageSize}
        total={query.data?.meta.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}
