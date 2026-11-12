import { useEffect, useMemo, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { Link } from "react-router";
import { FileText, Plus, Search } from "lucide-react";
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
import { useWarrantyClaimsList } from "../hooks/useWarrantyClaims";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { formatCurrency, formatDateTime } from "@/features/reports/utils/reportUtils";
import { WarrantyDataTable } from "../components/table/WarrantyDataTable";
import { WarrantyStatusBadge } from "../components/WarrantyStatusBadge";
import { ClaimCreationDialog } from "../components/ClaimCreationDialog";
import {
  CLAIM_STATUS_OPTIONS,
  CLAIM_TYPE_OPTIONS,
} from "../lib/warranty-format";
import type { WarrantyClaimRow, WarrantyClaimsFilters } from "../types/warranty.types";
import type { WarrantyTableFeatures } from "../components/table/warranty-table-features";

const columnHelper = createColumnHelper<WarrantyTableFeatures, WarrantyClaimRow>();

const DEFAULT_PAGE_SIZE = 20;

export function WarrantyClaimsPage() {
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [claimType, setClaimType] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [createOpen, setCreateOpen] = useState(false);

  const { hasPermission } = usePermissions();
  const debouncedSearch = useDebouncedValue(search.trim());

  const filters = useMemo<WarrantyClaimsFilters>(
    () => ({
      status,
      claimType: claimType === "all" ? undefined : claimType,
      search: debouncedSearch || undefined,
      page,
      pageSize,
    }),
    [status, claimType, debouncedSearch, page, pageSize],
  );

  const query = useWarrantyClaimsList(filters);

  useEffect(() => {
    if (query.isError) {
      toast.add({
        type: "error",
        title: "Could not load warranty claims",
        description: getErrorMessage(query.error),
      });
    }
  }, [query.isError, query.error]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, status, claimType, pageSize]);

  const columns = useMemo(
    () => [
      columnHelper.accessor("claimNumber", {
        id: "claimNumber",
        header: "Claim #",
        cell: ({ row }) => (
          <Link
            to={`/warranty/claims/${row.original.id}`}
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
      columnHelper.accessor("claimType", {
        id: "claimType",
        header: "Type",
        cell: ({ row }) => (
          <span className="text-xs capitalize">
            {row.original.claimType.replace(/_/g, " ")}
          </span>
        ),
      }),
      columnHelper.display({
        id: "customer",
        header: "Customer",
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate text-slate-800">
              {row.original.customerName ?? "Walk-in"}
            </p>
            {row.original.customerPhone ? (
              <p className="truncate text-xs text-slate-500">
                {row.original.customerPhone}
              </p>
            ) : null}
          </div>
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
            {row.original.serialNumber ? (
              <p className="truncate font-mono text-xs text-slate-400">
                SN: {row.original.serialNumber}
              </p>
            ) : null}
          </div>
        ),
      }),
      columnHelper.accessor("warrantyNumber", {
        id: "warranty",
        header: "Warranty",
        cell: ({ row }) => (
          <Link
            to={`/warranty/registry/${row.original.warrantyId}`}
            className="font-mono text-xs text-slate-600 hover:underline"
          >
            {row.original.warrantyNumber}
          </Link>
        ),
      }),
      columnHelper.accessor("repairCost", {
        id: "repairCost",
        header: "Repair cost",
        cell: ({ row }) => formatCurrency(row.original.repairCost),
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
            render={<Link to={`/warranty/claims/${row.original.id}`} />}
            variant="ghost"
            size="sm"
          >
            <FileText aria-hidden="true" />
            View
          </Button>
        ),
      }),
    ],
    [],
  );

  return (
    <div className="space-y-5 p-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-col gap-3 text-xl sm:flex-row sm:items-center sm:justify-between">
            <span>Warranty Claims</span>
            {hasPermission("warranty.claim.create") && (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus aria-hidden="true" />
                Create claim
              </Button>
            )}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            The workshop queue — inspect, approve, repair and hand back.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Status filter tabs */}
          <div
            className="flex flex-wrap gap-1.5"
            role="tablist"
            aria-label="Filter claims by status"
          >
            {CLAIM_STATUS_OPTIONS.map((option) => {
              const active = status === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setStatus(option.value)}
                  className={`inline-flex items-center rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                    active
                      ? "bg-slate-900 text-white shadow-xs"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative w-full lg:max-w-sm">
              <Search
                className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search claim, warranty, customer, product…"
                aria-label="Search claims"
                className="pl-8"
              />
            </div>
            <Select value={claimType} onValueChange={(value) => setClaimType(value)}>
              <SelectTrigger className="lg:w-48" aria-label="Filter by claim type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All claim types</SelectItem>
                {CLAIM_TYPE_OPTIONS.map((option) => (
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
        emptyMessage="No claims match this view."
        page={page}
        pageSize={pageSize}
        total={query.data?.meta.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      <ClaimCreationDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
