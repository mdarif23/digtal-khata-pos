import { useEffect, useMemo, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { Link } from "react-router";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { SearchInput } from "@/components/common/SearchInput";
import { toast } from "@/components/ui/toast";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { usePermissions } from "@/hooks/usePermissions";
import { useSupplierWarrantiesList } from "../hooks/useSupplierWarranties";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { formatDate } from "@/lib/format";
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
            className="font-medium text-primary hover:underline"
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
            <p className="truncate font-medium text-foreground">
              {row.original.productName}
            </p>
            {row.original.variantOptionLabel ? (
              <p className="truncate text-xs text-muted-foreground">
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
          <span className="font-mono text-xs text-muted-foreground">
            #{row.original.purchaseId} / line {row.original.purchaseItemId}
          </span>
        ),
      }),
      columnHelper.display({
        id: "coverage",
        header: "Coverage",
        cell: ({ row }) => (
          <div className="text-xs">
            <p className="text-foreground">
              {durationLabel(row.original.duration, row.original.durationUnit)}
            </p>
            <p className="text-muted-foreground">
              {formatDate(row.original.startDate)} → {formatDate(row.original.expiryDate)}
            </p>
          </div>
        ),
      }),
      columnHelper.display({
        id: "quantity",
        header: "Claimed / total",
        cell: ({ row }) => (
          <span className="tabular-nums text-foreground">
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
            <p className="max-w-xs truncate text-xs text-muted-foreground" title={row.original.terms}>
              {row.original.terms}
            </p>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      }),
    ]),
    [],
  );

  return (
    <PageContainer>
      <PageHeader
        title="Supplier Warranties"
        description="Warranty terms your suppliers committed to on purchased stock."
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus aria-hidden="true" />
              Add supplier warranty
            </Button>
          ) : null
        }
      />

      <Card>
        <CardContent>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search supplier, product…"
              ariaLabel="Search supplier warranties"
              className="lg:max-w-sm"
            />
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
    </PageContainer>
  );
}
