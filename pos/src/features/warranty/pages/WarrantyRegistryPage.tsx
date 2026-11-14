import { useEffect, useMemo, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { Link } from "react-router";
import { FileText, Plus, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { useWarrantiesList } from "../hooks/useWarranties";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { formatDate } from "@/lib/format";
import { WarrantyDataTable } from "../components/table/WarrantyDataTable";
import { WarrantyStatusBadge } from "../components/WarrantyStatusBadge";
import { ClaimCreationDialog } from "../components/ClaimCreationDialog";
import { WarrantyCertificateDialog } from "../components/WarrantyCertificateDialog";
import { durationLabel, WARRANTY_STATUS_OPTIONS } from "../lib/warranty-format";
import type { WarrantyListFilters, WarrantyListRow } from "../types/warranty.types";
import type { WarrantyTableFeatures } from "../components/table/warranty-table-features";

const columnHelper = createColumnHelper<WarrantyTableFeatures, WarrantyListRow>();

const DEFAULT_PAGE_SIZE = 20;

export function WarrantyRegistryPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [provider, setProvider] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const [claimTarget, setClaimTarget] = useState<WarrantyListRow | null>(null);
  const [claimOpen, setClaimOpen] = useState(false);
  const [certificateId, setCertificateId] = useState<number | null>(null);

  const { hasPermission } = usePermissions();
  const debouncedSearch = useDebouncedValue(search.trim());
  const debouncedProvider = useDebouncedValue(provider.trim());

  const filters = useMemo<WarrantyListFilters>(
    () => ({
      status,
      search: debouncedSearch || undefined,
      provider: debouncedProvider || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      page,
      pageSize,
    }),
    [status, debouncedSearch, debouncedProvider, dateFrom, dateTo, page, pageSize],
  );

  const query = useWarrantiesList(filters);

  useEffect(() => {
    if (query.isError) {
      toast.add({
        type: "error",
        title: "Could not load the warranty registry",
        description: getErrorMessage(query.error),
      });
    }
  }, [query.isError, query.error]);

  // Any filter change restarts pagination.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, status, debouncedProvider, dateFrom, dateTo, pageSize]);

  const canCreateClaim = hasPermission("warranty.claim.create");

  const columns = useMemo(
    () => columnHelper.columns([
      columnHelper.accessor("warrantyNumber", {
        id: "warrantyNumber",
        header: "Warranty #",
        cell: ({ row }) => (
          <Link
            to={`/warranty/registry/${row.original.id}`}
            className="font-mono text-sm font-semibold text-primary hover:underline"
          >
            {row.original.warrantyNumber}
          </Link>
        ),
      }),
      columnHelper.accessor("status", {
        id: "status",
        header: "Status",
        cell: ({ row }) => <WarrantyStatusBadge status={row.original.status} />,
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
        id: "serialNumber",
        header: "Serial",
        cell: ({ row }) =>
          row.original.serialNumber ? (
            <span className="font-mono text-xs">{row.original.serialNumber}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      }),
      columnHelper.display({
        id: "customer",
        header: "Customer",
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate text-foreground">
              {row.original.customerName ?? "Walk-in"}
            </p>
            {row.original.customerPhone ? (
              <p className="truncate text-xs text-muted-foreground">
                {row.original.customerPhone}
              </p>
            ) : null}
          </div>
        ),
      }),
      columnHelper.display({
        id: "invoice",
        header: "Invoice",
        cell: ({ row }) =>
          row.original.invoiceNumber ? (
            <span className="font-mono text-xs">{row.original.invoiceNumber}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
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
              Ends {formatDate(row.original.expiryDate)}
            </p>
          </div>
        ),
      }),
      columnHelper.display({
        id: "quantity",
        header: "Qty",
        cell: ({ row }) => (
          <span className="tabular-nums text-foreground">
            {row.original.quantity}
            {row.original.returnedQuantity ? (
              <span className="text-xs text-muted-foreground">
                {" "}
                (−{row.original.returnedQuantity})
              </span>
            ) : null}
          </span>
        ),
      }),
      columnHelper.display({
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              render={<Link to={`/warranty/registry/${row.original.id}`} />}
              variant="ghost"
              size="sm"
            >
              <FileText aria-hidden="true" />
              View
            </Button>
            {canCreateClaim && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setClaimTarget(row.original);
                  setClaimOpen(true);
                }}
              >
                <Plus aria-hidden="true" />
                Claim
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Print certificate for ${row.original.warrantyNumber}`}
              onClick={() => setCertificateId(row.original.id)}
            >
              <Printer aria-hidden="true" />
            </Button>
          </div>
        ),
      }),
    ]),
    [canCreateClaim],
  );

  return (
    <PageContainer>
      <PageHeader
        title="Warranty Registry"
        description="Every customer warranty issued from sales — search, inspect and print certificates."
      />

      <Card>
        <CardContent>
          <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search warranty, product, customer, serial…"
              ariaLabel="Search warranties"
              className="lg:max-w-sm"
            />

            <Select
              value={status}
              onValueChange={(value) => setStatus(value ?? "all")}
            >
              <SelectTrigger className="lg:w-44" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WARRANTY_STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Input
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              placeholder="Provider"
              aria-label="Filter by provider"
              className="lg:w-36"
            />
            <Input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              aria-label="From date"
              className="lg:w-38"
            />
            <Input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              aria-label="To date"
              className="lg:w-38"
            />
          </div>
        </CardContent>
      </Card>

      <WarrantyDataTable
        columns={columns}
        data={query.data?.data ?? []}
        loading={query.isPending}
        error={query.isError ? getErrorMessage(query.error) : null}
        onRetry={query.refetch}
        emptyMessage="No warranties match these filters."
        page={page}
        pageSize={pageSize}
        total={query.data?.meta.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      <ClaimCreationDialog
        open={claimOpen}
        onOpenChange={setClaimOpen}
        preselectedWarranty={claimTarget}
      />
      <WarrantyCertificateDialog
        warrantyId={certificateId ?? 0}
        open={certificateId !== null}
        onOpenChange={(open) => {
          if (!open) setCertificateId(null);
        }}
      />
    </PageContainer>
  );
}
