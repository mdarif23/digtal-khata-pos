import { useEffect, useMemo, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { Link, useParams } from "react-router";
import { ArrowLeft, Plus, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { PageContainer } from "@/components/common/PageContainer";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { usePermissions } from "@/hooks/usePermissions";
import { useWarrantyDetail } from "../hooks/useWarranties";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import { WarrantyDataTable } from "../components/table/WarrantyDataTable";
import { WarrantyStatusBadge } from "../components/WarrantyStatusBadge";
import { ClaimCreationDialog } from "../components/ClaimCreationDialog";
import { WarrantyCertificateDialog } from "../components/WarrantyCertificateDialog";
import { durationLabel } from "../lib/warranty-format";
import type { WarrantyClaimRow } from "../types/warranty.types";
import type { WarrantyTableFeatures } from "../components/table/warranty-table-features";

const columnHelper = createColumnHelper<WarrantyTableFeatures, WarrantyClaimRow>();

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-1.5 last:border-0">
      <span className="text-xs whitespace-nowrap text-muted-foreground">{label}</span>
      <span className="text-right text-sm text-foreground">{value}</span>
    </div>
  );
}

export function WarrantyRegistryDetailPage() {
  const { id } = useParams();
  const warrantyId = Number(id);
  const query = useWarrantyDetail(warrantyId);
  const { hasPermission } = usePermissions();

  const [claimOpen, setClaimOpen] = useState(false);
  const [certificateOpen, setCertificateOpen] = useState(false);

  const canCreateClaim = hasPermission("warranty.claim.create");

  useEffect(() => {
    if (query.isError) {
      toast.add({
        type: "error",
        title: "Could not load the warranty",
        description: getErrorMessage(query.error),
      });
    }
  }, [query.isError, query.error]);

  const claimColumns = useMemo(
    () => columnHelper.columns([
      columnHelper.accessor("claimNumber", {
        id: "claimNumber",
        header: "Claim #",
        cell: ({ row }) => (
          <Link
            to={`/warranty/claims/${row.original.id}`}
            className="font-mono text-sm font-semibold text-primary hover:underline"
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
        id: "problem",
        header: "Reported problem",
        cell: ({ row }) => (
          <p className="max-w-md text-xs text-muted-foreground">
            {row.original.reportedProblem}
          </p>
        ),
      }),
      columnHelper.accessor("repairCost", {
        id: "repairCost",
        header: "Repair cost",
        cell: ({ row }) => (
          <span className="block tabular-nums">
            {formatCurrency(row.original.repairCost)}
          </span>
        ),
      }),
      columnHelper.accessor("createdAt", {
        id: "createdAt",
        header: "Filed",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {formatDateTime(row.original.createdAt)}
          </span>
        ),
      }),
    ]),
    [],
  );

  if (query.isPending) {
    return (
      <PageContainer width="narrow">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
        <Skeleton className="h-48 rounded-xl" />
      </PageContainer>
    );
  }

  if (query.isError || !query.data) {
    return (
      <PageContainer width="narrow">
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/10 py-10 text-center"
        >
          <p className="text-sm font-medium text-destructive">
            Unable to load this warranty.
          </p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      </PageContainer>
    );
  }

  const detail = query.data;
  const warranty = detail.warranty;

  return (
    <PageContainer width="narrow">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            render={<Link to="/warranty/registry" />}
            variant="outline"
            size="icon"
            aria-label="Back to the warranty registry"
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <div className="min-w-0">
            <h1 className="font-mono text-xl font-semibold text-foreground">
              {warranty.warrantyNumber}
            </h1>
            <p className="text-sm text-muted-foreground">
              {warranty.productName}
              {warranty.variantOptionLabel ? ` · ${warranty.variantOptionLabel}` : ""}
            </p>
          </div>
          <WarrantyStatusBadge status={warranty.status} />
        </div>
        <div className="flex items-center gap-2">
          {canCreateClaim && (
            <Button onClick={() => setClaimOpen(true)}>
              <Plus aria-hidden="true" />
              Create claim
            </Button>
          )}
          <Button variant="outline" onClick={() => setCertificateOpen(true)}>
            <Printer aria-hidden="true" />
            Print certificate
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Customer & sale</CardTitle>
          </CardHeader>
          <CardContent>
            <Fact label="Customer" value={detail.customerName ?? "Walk-in"} />
            <Fact label="Phone" value={detail.customerPhone ?? "—"} />
            <Fact label="Email" value={detail.customerEmail ?? "—"} />
            <Fact label="Address" value={detail.customerAddress ?? "—"} />
            <Fact
              label="Invoice"
              value={
                detail.invoiceNumber ? (
                  <span className="font-mono text-xs">{detail.invoiceNumber}</span>
                ) : (
                  "—"
                )
              }
            />
            <Fact label="Sale date" value={formatDate(detail.saleDate)} />
            <Fact label="Location" value={detail.locationName ?? "—"} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Coverage</CardTitle>
          </CardHeader>
          <CardContent>
            <Fact
              label="Duration"
              value={`${durationLabel(warranty.duration, warranty.durationUnit)} · ${warranty.warrantyType}`}
            />
            <Fact label="Provider" value={warranty.provider ?? "Shop warranty"} />
            <Fact label="Starts" value={formatDate(warranty.startDate)} />
            <Fact label="Expires" value={formatDate(warranty.expiryDate)} />
            <Fact
              label="Quantity"
              value={`${warranty.quantity}${warranty.returnedQuantity ? ` (returned ${warranty.returnedQuantity})` : ""}`}
            />
            <Fact
              label="Serial"
              value={
                warranty.serialNumber ? (
                  <span className="font-mono text-xs">{warranty.serialNumber}</span>
                ) : (
                  "—"
                )
              }
            />
            {warranty.voidReason ? (
              <Fact
                label="Void reason"
                value={<span className="text-xs text-destructive">{warranty.voidReason}</span>}
              />
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="mb-3 text-base font-semibold text-foreground">
          Claims on this warranty
        </h2>
        <WarrantyDataTable
          columns={claimColumns}
          data={detail.claims}
          loading={query.isFetching}
          emptyMessage="No claims have been filed against this warranty yet."
        />
      </div>

      <ClaimCreationDialog
        open={claimOpen}
        onOpenChange={setClaimOpen}
        preselectedWarranty={warranty}
      />
      <WarrantyCertificateDialog
        warrantyId={warrantyId}
        open={certificateOpen}
        onOpenChange={setCertificateOpen}
      />
    </PageContainer>
  );
}
