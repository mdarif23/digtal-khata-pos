import { useEffect, useMemo } from "react";
import { Link } from "react-router";
import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  CircleDollarSign,
  Clock,
  PackageCheck,
  ScanSearch,
  ShieldCheck,
  Truck,
  Wrench,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { usePermissions } from "@/hooks/usePermissions";
import { useWarrantiesList, useWarrantyOverview } from "../hooks/useWarranties";
import { useWarrantyClaimsList } from "../hooks/useWarrantyClaims";
import { ReportMetricCard } from "@/features/reports/components/ReportMetricCard";
import { formatDate, formatDateTime } from "@/lib/format";
import { WarrantyStatusBadge } from "../components/WarrantyStatusBadge";
import { OPEN_CLAIM_STATUSES } from "../lib/warranty-format";
import type { WarrantyListRow, WarrantyClaimRow } from "../types/warranty.types";

const QUICK_LIST_SIZE = 5;

function QuickListShell({
  title,
  viewAllTo,
  viewAllLabel,
  children,
}: {
  title: string;
  viewAllTo: string;
  viewAllLabel: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>{title}</span>
          <Link
            to={viewAllTo}
            className="text-xs font-medium text-primary hover:underline"
          >
            {viewAllLabel}
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">{children}</CardContent>
    </Card>
  );
}

function EmptyHint({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
      {message}
    </p>
  );
}

function ExpiringRow({ warranty }: { warranty: WarrantyListRow }) {
  return (
    <Link
      to={`/warranty/registry/${warranty.id}`}
      className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 transition hover:bg-muted/50"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">
          {warranty.productName}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {warranty.warrantyNumber} · {warranty.customerName ?? "Walk-in"} · ends{" "}
          {formatDate(warranty.expiryDate)}
        </p>
      </div>
      <WarrantyStatusBadge status={warranty.status} />
    </Link>
  );
}

function OpenClaimRow({ claim }: { claim: WarrantyClaimRow }) {
  return (
    <Link
      to={`/warranty/claims/${claim.id}`}
      className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 transition hover:bg-muted/50"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">
          {claim.claimNumber} · {claim.productName}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {claim.customerName ?? "Walk-in"} · {formatDateTime(claim.createdAt)}
        </p>
      </div>
      <WarrantyStatusBadge status={claim.status} />
    </Link>
  );
}

function QuickListSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  );
}

export function WarrantyOverviewPage() {
  const { hasPermission } = usePermissions();
  const overview = useWarrantyOverview();

  // Quick lists: expiring warranties and the open claims queue.
  const expiring = useWarrantiesList({
    status: "expiring",
    page: 1,
    pageSize: QUICK_LIST_SIZE,
  });
  const claimsFeed = useWarrantyClaimsList({
    status: "all",
    page: 1,
    pageSize: 25,
  });

  const canSeeSupplier = hasPermission("warranty.supplier.view");
  const canCreateClaim = hasPermission("warranty.claim.create");

  useEffect(() => {
    if (overview.isError) {
      toast.add({
        type: "error",
        title: "Could not load the warranty overview",
        description: getErrorMessage(overview.error),
      });
    }
  }, [overview.isError, overview.error]);

  const openClaims = useMemo(
    () =>
      (claimsFeed.data?.data ?? [])
        .filter((claim) => OPEN_CLAIM_STATUSES.has(claim.status))
        .slice(0, QUICK_LIST_SIZE),
    [claimsFeed.data],
  );

  const data = overview.data;

  return (
    <PageContainer>
      <PageHeader
        title="Warranty Overview"
        description="Customer coverage, the claim workshop, and supplier recovery at a glance."
      />

      {overview.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ReportMetricCard
            title="Active warranties"
            value={data?.activeWarranties}
            isCurrency={false}
            isCount
            icon={ShieldCheck}
            accent="bg-success/10 text-success"
          />
          <ReportMetricCard
            title="Expiring soon"
            value={data?.expiringSoon}
            isCurrency={false}
            isCount
            icon={CalendarClock}
            accent="bg-warning/10 text-warning"
            valueClassName="text-warning"
          />
          <ReportMetricCard
            title="Expired"
            value={data?.expiredWarranties}
            isCurrency={false}
            isCount
            icon={AlertTriangle}
            accent="bg-destructive/10 text-destructive"
            valueClassName="text-destructive"
          />
          <ReportMetricCard
            title="Covered units"
            value={data?.coveredUnits}
            isCurrency={false}
            isCount
            icon={PackageCheck}
            accent="bg-info/10 text-info"
          />
          <ReportMetricCard
            title="Open claims"
            value={data?.openClaims}
            isCurrency={false}
            isCount
            icon={Clock}
            accent="bg-info/10 text-info"
          />
          <ReportMetricCard
            title="Pending inspections"
            value={data?.pendingInspections}
            isCurrency={false}
            isCount
            icon={ScanSearch}
            accent="bg-muted text-muted-foreground"
          />
          <ReportMetricCard
            title="In repair"
            value={data?.inRepair}
            isCurrency={false}
            isCount
            icon={Wrench}
            accent="bg-warning/10 text-warning"
          />
          <ReportMetricCard
            title="Ready for pickup"
            value={data?.readyForPickup}
            isCurrency={false}
            isCount
            icon={BadgeCheck}
            accent="bg-info/10 text-info"
          />
          <ReportMetricCard
            title="Total repair cost"
            value={data?.totalRepairCost}
            isCurrency
            icon={CircleDollarSign}
            accent="bg-primary/10 text-primary"
          />
          {canSeeSupplier && (
            <ReportMetricCard
              title="Open supplier claims"
              value={data?.openSupplierClaims}
              isCurrency={false}
              isCount
              icon={Truck}
              accent="bg-info/10 text-info"
            />
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <QuickListShell
          title="Expiring warranties"
          viewAllTo="/warranty/registry"
          viewAllLabel="View registry"
        >
          {expiring.isPending ? (
            <QuickListSkeleton />
          ) : (expiring.data?.data ?? []).length === 0 ? (
            <EmptyHint message="Nothing is expiring soon." />
          ) : (
            (expiring.data?.data ?? []).map((warranty) => (
              <ExpiringRow key={warranty.id} warranty={warranty} />
            ))
          )}
        </QuickListShell>

        <QuickListShell
          title="Open claims"
          viewAllTo="/warranty/claims"
          viewAllLabel="View claims"
        >
          {claimsFeed.isPending ? (
            <QuickListSkeleton />
          ) : openClaims.length === 0 ? (
            <EmptyHint
              message={
                canCreateClaim
                  ? "No open claims — the workshop queue is clear."
                  : "No open claims."
              }
            />
          ) : (
            openClaims.map((claim) => (
              <OpenClaimRow key={claim.id} claim={claim} />
            ))
          )}
        </QuickListShell>
      </div>
    </PageContainer>
  );
}
