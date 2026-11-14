import { useMemo, useState } from "react";
import { PackageSearch, Receipt, Wallet, Wrench } from "lucide-react";
import { useReportData } from "@/features/reports/hooks/useReportData";
import type { ReportFilters } from "@/features/reports/types/report.types";
import { exportToCsv } from "@/features/reports/utils/reportUtils";
import { formatCurrency } from "@/lib/format";
import { ReportHeader } from "@/features/reports/components/ReportHeader";
import { ReportDateFilter } from "@/features/reports/components/ReportDateFilter";
import { ReportMetricCard } from "@/features/reports/components/ReportMetricCard";
import { ReportTable, type ReportColumn } from "@/features/reports/components/ReportTable";
import { getWarrantyClaimsReportApi } from "../../api/warranty.api";
import { WarrantyStatusBadge } from "../WarrantyStatusBadge";
import { statusLabel } from "../../lib/warranty-format";
import type { WarrantyClaimsReportData } from "../../types/warranty.types";

/**
 * Warranty Claims report (GET /reports/warranty/claims) — claim counts by
 * status/type and per-product claim rates.
 */
export function WarrantyClaimsReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_year",
  });

  const { data, loading, error, refetch } = useReportData<WarrantyClaimsReportData>(
    () =>
      getWarrantyClaimsReportApi({
        dateFrom: filters.dateRange?.startDate,
        dateTo: filters.dateRange?.endDate,
        locationId: filters.locationId,
      }),
    [filters],
  );

  const byStatus = data?.byStatus ?? [];
  const byProduct = data?.byProduct ?? [];

  const totalClaims = useMemo(
    () => byStatus.reduce((sum, row) => sum + row.claimCount, 0),
    [byStatus],
  );
  const totalCost = useMemo(
    () => byProduct.reduce((sum, row) => sum + row.repairCost, 0),
    [byProduct],
  );
  const unitsAffected = useMemo(
    () => byProduct.reduce((sum, row) => sum + row.unitsAffected, 0),
    [byProduct],
  );

  const handleExport = () => {
    const statusHeaders = ["Status", "Claim Type", "Claims"];
    const statusRows = byStatus.map((row) => [
      statusLabel(row.status),
      row.claimType.replace(/_/g, " "),
      row.claimCount,
    ]);
    const productHeaders = [
      "Product",
      "Claims",
      "Units Affected",
      "Covered Units Issued",
      "Claim Rate (%)",
      "Repair Cost (BDT)",
    ];
    const productRows = byProduct.map((row) => [
      row.productName,
      row.claimCount,
      row.unitsAffected,
      row.coveredUnitsIssued,
      row.claimRate,
      row.repairCost,
    ]);
    exportToCsv(
      "warranty-claims-report-status",
      statusHeaders,
      statusRows,
    );
    exportToCsv(
      "warranty-claims-report-products",
      productHeaders,
      productRows,
    );
  };

  const statusColumns: ReportColumn<WarrantyClaimsReportData["byStatus"][number]>[] = [
    {
      key: "status",
      header: "Status",
      render: (row) => <WarrantyStatusBadge status={row.status} />,
    },
    {
      key: "claimType",
      header: "Claim type",
      render: (row) => (
        <span className="text-xs capitalize">{row.claimType.replace(/_/g, " ")}</span>
      ),
    },
    {
      key: "claimCount",
      header: "Claims",
      headerClassName: "text-right",
      className: "text-right font-medium tabular-nums text-foreground",
      render: (row) => row.claimCount,
    },
  ];

  const productColumns: ReportColumn<WarrantyClaimsReportData["byProduct"][number]>[] = [
    {
      key: "productName",
      header: "Product",
      render: (row) => (
        <span className="font-medium text-foreground">{row.productName}</span>
      ),
    },
    {
      key: "claimCount",
      header: "Claims",
      render: (row) => row.claimCount,
    },
    {
      key: "unitsAffected",
      header: "Units affected",
      render: (row) => row.unitsAffected,
    },
    {
      key: "coveredUnitsIssued",
      header: "Covered units issued",
      render: (row) => row.coveredUnitsIssued,
    },
    {
      key: "claimRate",
      header: "Claim rate",
      render: (row) => (
        <span className="font-medium tabular-nums text-foreground">
          {Number(row.claimRate).toFixed(1)}%
        </span>
      ),
    },
    {
      key: "repairCost",
      header: "Repair cost",
      render: (row) => formatCurrency(row.repairCost),
    },
  ];

  return (
    <div className="space-y-6">
      <ReportHeader
        category="Warranty Reports"
        title="Warranty Claims"
        description="Where claims come from — status mix and the products that generate them."
        onExport={handleExport}
        onRefresh={refetch}
        loading={loading}
      />

      <ReportDateFilter
        filters={filters}
        onFiltersChange={setFilters}
        showLocationFilter
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReportMetricCard
          title="Total claims"
          value={totalClaims}
          isCurrency={false}
          isCount
          icon={Receipt}
          accent="bg-info/10 text-info"
        />
        <ReportMetricCard
          title="Products with claims"
          value={byProduct.length}
          isCurrency={false}
          isCount
          icon={PackageSearch}
          accent="bg-info/10 text-info"
        />
        <ReportMetricCard
          title="Units affected"
          value={unitsAffected}
          isCurrency={false}
          isCount
          icon={Wrench}
          accent="bg-warning/10 text-warning"
        />
        <ReportMetricCard
          title="Total repair cost"
          value={totalCost}
          isCurrency
          icon={Wallet}
          accent="bg-destructive/10 text-destructive"
          valueClassName="text-destructive"
        />
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Claims by status</h3>
        <ReportTable
          columns={statusColumns}
          data={byStatus}
          loading={loading}
          error={error}
          emptyMessage="No claims in this period."
          keyExtractor={(row) => `${row.status}-${row.claimType}`}
        />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Claims by product</h3>
        <ReportTable
          columns={productColumns}
          data={byProduct}
          loading={loading}
          error={error}
          emptyMessage="No product-level claim data in this period."
          keyExtractor={(row) => row.productId}
        />
      </section>
    </div>
  );
}
