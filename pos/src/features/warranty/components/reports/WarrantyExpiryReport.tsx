import { useMemo, useState } from "react";
import { CalendarClock, Layers, ShieldAlert, ShieldCheck } from "lucide-react";
import { useReportData } from "@/features/reports/hooks/useReportData";
import type { ReportFilters } from "@/features/reports/types/report.types";
import { exportToCsv } from "@/features/reports/utils/reportUtils";
import { formatDate } from "@/lib/format";
import { ReportHeader } from "@/features/reports/components/ReportHeader";
import { ReportDateFilter } from "@/features/reports/components/ReportDateFilter";
import { ReportMetricCard } from "@/features/reports/components/ReportMetricCard";
import { ReportTable, type ReportColumn } from "@/features/reports/components/ReportTable";
import { getWarrantyExpiryReportApi } from "../../api/warranty.api";
import { WarrantyStatusBadge } from "../WarrantyStatusBadge";
import type { WarrantyExpiryReportRow } from "../../types/warranty.types";

/**
 * Warranty Expiry report (GET /reports/warranty/expiry). The backend buckets
 * each warranty as valid / expiring_soon / expired; rows are snake_case
 * straight from the reporting SQL.
 */

const BUCKET_OPTIONS = [
  { value: "all", label: "All buckets" },
  { value: "valid", label: "Valid" },
  { value: "expiring_soon", label: "Expiring soon" },
  { value: "expired", label: "Expired" },
] as const;

type ExpiryEnvelope = {
  success: boolean;
  data: { data: WarrantyExpiryReportRow[]; total: number; page: number; limit: number };
};

export function WarrantyExpiryReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
    page: 1,
    limit: 50,
  });
  const [bucket, setBucket] = useState("all");

  const { data, loading, error, refetch } = useReportData<ExpiryEnvelope["data"]>(
    () =>
      getWarrantyExpiryReportApi({
        locationId: filters.locationId,
        page: filters.page,
        limit: filters.limit,
        bucket,
        dateFrom: filters.dateRange?.startDate,
        dateTo: filters.dateRange?.endDate,
      }),
    [filters, bucket],
  );

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  const validCount = rows.filter((r) => r.bucket === "valid").length;
  const expiringCount = rows.filter((r) => r.bucket === "expiring_soon").length;
  const expiredCount = rows.filter((r) => r.bucket === "expired").length;

  const handleExport = () => {
    const headers = [
      "Warranty Number",
      "Bucket",
      "Status",
      "Customer",
      "Product",
      "Variant",
      "Serial",
      "Quantity",
      "Provider",
      "Invoice",
      "Start Date",
      "Expiry Date",
      "Location",
    ];
    const exportRows = rows.map((r) => [
      r.warrantyNumber,
      r.bucket,
      r.status,
      r.customer_name ?? "",
      r.product_name,
      r.variant_label ?? "",
      r.serialNumber ?? "",
      r.quantity,
      r.provider ?? "",
      r.invoice_number ?? "",
      r.start_date ?? "",
      r.expiry_date ?? "",
      r.location_name ?? "",
    ]);
    exportToCsv("warranty-expiry-report", headers, exportRows);
  };

  const columns: ReportColumn<WarrantyExpiryReportRow>[] = useMemo(
    () => [
      {
        key: "warrantyNumber",
        header: "Warranty #",
        render: (r) => (
          <span className="font-mono font-semibold text-foreground">
            {r.warrantyNumber}
          </span>
        ),
      },
      {
        key: "bucket",
        header: "Bucket",
        render: (r) => (
          <span
            className={`text-xs font-semibold ${
              r.bucket === "expired"
                ? "text-destructive"
                : r.bucket === "expiring_soon"
                  ? "text-warning"
                  : "text-success"
            }`}
          >
            {r.bucket.replace(/_/g, " ")}
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        render: (r) => <WarrantyStatusBadge status={r.status} />,
      },
      {
        key: "customer_name",
        header: "Customer",
        render: (r) => (
          <div className="text-xs">
            <p className="text-foreground">{r.customer_name ?? "Walk-in"}</p>
            <p className="font-mono text-muted-foreground">{r.invoice_number ?? "—"}</p>
          </div>
        ),
      },
      {
        key: "product_name",
        header: "Product",
        render: (r) => (
          <div className="max-w-xs">
            <p className="truncate font-medium text-foreground">{r.product_name}</p>
            {r.variant_label ? (
              <p className="truncate text-xs text-muted-foreground">{r.variant_label}</p>
            ) : null}
            {r.serialNumber ? (
              <p className="truncate font-mono text-xs text-muted-foreground">
                SN: {r.serialNumber}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        key: "quantity",
        header: "Qty",
        render: (r) => r.quantity,
      },
      {
        key: "provider",
        header: "Provider",
        render: (r) => r.provider ?? "Shop warranty",
      },
      {
        key: "start_date",
        header: "Start",
        render: (r) => (
          <span className="text-xs text-muted-foreground">{formatDate(r.start_date)}</span>
        ),
      },
      {
        key: "expiry_date",
        header: "Expiry",
        render: (r) => (
          <span
            className={`text-xs font-semibold tabular-nums ${
              r.bucket === "expired"
                ? "text-destructive"
                : r.bucket === "expiring_soon"
                  ? "text-warning"
                  : "text-foreground"
            }`}
          >
            {formatDate(r.expiry_date)}
          </span>
        ),
      },
      {
        key: "location_name",
        header: "Location",
        render: (r) => (
          <span className="text-xs text-muted-foreground">{r.location_name ?? "—"}</span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <ReportHeader
        category="Warranty Reports"
        title="Warranty Expiry"
        description="Warranties by validity bucket — chase renewals before coverage lapses."
        onExport={handleExport}
        onRefresh={refetch}
        loading={loading}
      />

      <ReportDateFilter
        filters={filters}
        onFiltersChange={setFilters}
        extraFilters={
          <select
            value={bucket}
            onChange={(event) => setBucket(event.target.value)}
            className="h-9 rounded-lg border border-input bg-card px-3 text-sm text-foreground shadow-2xs outline-none"
            aria-label="Filter by expiry bucket"
          >
            {BUCKET_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReportMetricCard
          title="Warranties listed"
          value={total}
          isCurrency={false}
          isCount
          icon={Layers}
          accent="bg-info/10 text-info"
        />
        <ReportMetricCard
          title="Valid"
          value={validCount}
          isCurrency={false}
          isCount
          icon={ShieldCheck}
          accent="bg-success/10 text-success"
        />
        <ReportMetricCard
          title="Expiring soon"
          value={expiringCount}
          isCurrency={false}
          isCount
          icon={CalendarClock}
          accent="bg-warning/10 text-warning"
          valueClassName="text-warning"
        />
        <ReportMetricCard
          title="Expired"
          value={expiredCount}
          isCurrency={false}
          isCount
          icon={ShieldAlert}
          accent="bg-destructive/10 text-destructive"
          valueClassName="text-destructive"
        />
      </div>

      <ReportTable
        columns={columns}
        data={rows}
        loading={loading}
        error={error}
        keyExtractor={(r) => r.id}
        page={data?.page ?? filters.page ?? 1}
        limit={data?.limit ?? filters.limit ?? 50}
        total={total}
        onPageChange={(page) => setFilters({ ...filters, page })}
      />
    </div>
  );
}
