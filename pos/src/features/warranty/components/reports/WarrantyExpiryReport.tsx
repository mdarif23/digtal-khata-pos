import { useMemo, useState } from "react";
import { CalendarClock, Layers, ShieldAlert, ShieldCheck } from "lucide-react";
import { useReportData } from "@/features/reports/hooks/useReportData";
import type { ReportFilters } from "@/features/reports/types/report.types";
import {
  exportToCsv,
  formatDate,
} from "@/features/reports/utils/reportUtils";
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
          <span className="font-mono font-semibold text-slate-900">
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
                ? "text-rose-600"
                : r.bucket === "expiring_soon"
                  ? "text-amber-600"
                  : "text-emerald-600"
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
            <p className="text-slate-800">{r.customer_name ?? "Walk-in"}</p>
            <p className="font-mono text-slate-400">{r.invoice_number ?? "—"}</p>
          </div>
        ),
      },
      {
        key: "product_name",
        header: "Product",
        render: (r) => (
          <div className="max-w-xs">
            <p className="truncate font-medium text-slate-900">{r.product_name}</p>
            {r.variant_label ? (
              <p className="truncate text-xs text-slate-500">{r.variant_label}</p>
            ) : null}
            {r.serialNumber ? (
              <p className="truncate font-mono text-xs text-slate-400">
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
          <span className="text-xs text-slate-500">{formatDate(r.start_date)}</span>
        ),
      },
      {
        key: "expiry_date",
        header: "Expiry",
        render: (r) => (
          <span
            className={`text-xs font-semibold ${
              r.bucket === "expired"
                ? "text-rose-600"
                : r.bucket === "expiring_soon"
                  ? "text-amber-600"
                  : "text-slate-700"
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
          <span className="text-xs text-slate-500">{r.location_name ?? "—"}</span>
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
            className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 shadow-2xs outline-none"
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
          accent="bg-sky-50 text-sky-700"
        />
        <ReportMetricCard
          title="Valid"
          value={validCount}
          isCurrency={false}
          isCount
          icon={ShieldCheck}
          accent="bg-emerald-50 text-emerald-700"
        />
        <ReportMetricCard
          title="Expiring soon"
          value={expiringCount}
          isCurrency={false}
          isCount
          icon={CalendarClock}
          accent="bg-amber-50 text-amber-700"
          valueClassName="text-amber-600"
        />
        <ReportMetricCard
          title="Expired"
          value={expiredCount}
          isCurrency={false}
          isCount
          icon={ShieldAlert}
          accent="bg-rose-50 text-rose-700"
          valueClassName="text-rose-600"
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
