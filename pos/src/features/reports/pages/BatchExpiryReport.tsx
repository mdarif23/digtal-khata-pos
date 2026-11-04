import React, { useState } from "react";
import { AlertTriangle, Calendar, Layers } from "lucide-react";
import { reportsApi } from "../api/reports.api";
import { useReportData } from "../hooks/useReportData";
import type { ReportFilters, BatchRow } from "../types/report.types";
import {
  exportToCsv,
  formatCurrency,
  formatDate,
  formatNumber,
} from "../utils/reportUtils";
import { ReportHeader } from "../components/ReportHeader";
import { ReportDateFilter } from "../components/ReportDateFilter";
import { ReportMetricCard } from "../components/ReportMetricCard";
import { ReportTable, type ReportColumn } from "../components/ReportTable";
import { StatusBadge } from "../components/StatusBadge";

export function BatchExpiryReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
    page: 1,
    limit: 50,
  });

  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getBatchExpiry(filters),
    [filters]
  );

  const batches = data?.data || [];
  const total = data?.total || 0;

  const expiredCount = batches.filter((b) => b.expiryStatus === "expired").length;
  const expiringSoonCount = batches.filter(
    (b) => b.expiryStatus === "expiring_soon"
  ).length;

  const handleExport = () => {
    const headers = [
      "Batch Number",
      "Product Name",
      "Variant",
      "SKU",
      "Purchase Price (BDT)",
      "Received Qty",
      "Remaining Qty",
      "Manufactured Date",
      "Expiry Date",
      "Status",
    ];
    const exportRows = batches.map((b) => [
      b.batchNumber,
      b.productName,
      b.variantOptions ?? "",
      b.sku,
      b.purchasePrice,
      b.quantityReceived,
      b.quantityRemaining,
      b.manufacturedDate,
      b.expiryDate,
      b.expiryStatus,
    ]);
    exportToCsv("batch-expiry-report", headers, exportRows);
  };

  const columns: ReportColumn<BatchRow>[] = [
    {
      key: "batchNumber",
      header: "Batch #",
      render: (r) => (
        <span className="font-mono font-semibold text-slate-900">
          {r.batchNumber}
        </span>
      ),
    },
    {
      key: "productName",
      header: "Product & Variant",
      render: (r) => (
        <div>
          <p className="font-semibold text-slate-900">{r.productName}</p>
          {r.variantOptions ? (
            <p className="text-xs text-slate-500">{r.variantOptions}</p>
          ) : null}
          <p className="text-xs text-slate-400 font-mono">SKU: {r.sku}</p>
        </div>
      ),
    },
    {
      key: "purchasePrice",
      header: "Batch Cost",
      render: (r) => formatCurrency(r.purchasePrice),
    },
    {
      key: "quantityRemaining",
      header: "Remaining / Received",
      render: (r) => (
        <span className="font-medium text-slate-800">
          {formatNumber(r.quantityRemaining)}{" "}
          <span className="text-xs text-slate-400">
            / {formatNumber(r.quantityReceived)}
          </span>
        </span>
      ),
    },
    {
      key: "manufacturedDate",
      header: "MFG Date",
      render: (r) => (
        <span className="text-xs text-slate-500">
          {formatDate(r.manufacturedDate)}
        </span>
      ),
    },
    {
      key: "expiryDate",
      header: "EXP Date",
      render: (r) => (
        <span
          className={`text-xs font-semibold ${
            r.expiryStatus === "expired"
              ? "text-rose-600"
              : r.expiryStatus === "expiring_soon"
              ? "text-amber-600"
              : "text-slate-700"
          }`}
        >
          {formatDate(r.expiryDate)}
        </span>
      ),
    },
    {
      key: "expiryStatus",
      header: "Expiry Status",
      render: (r) => <StatusBadge status={r.expiryStatus} />,
    },
  ];

  return (
    <div className="space-y-6">
      <ReportHeader
        category="Inventory Reports"
        title="Batch & Expiry Tracking"
        description="Monitor batch depletion, shelf life, expired lots, and expiring stock."
        onExport={handleExport}
        onRefresh={refetch}
        loading={loading}
      />

      <ReportDateFilter filters={filters} onFiltersChange={setFilters} />

      {/* Metric Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReportMetricCard
          title="Active Batches"
          value={total}
          isCurrency={false}
          isCount
          icon={Layers}
          accent="bg-sky-50 text-sky-700"
        />
        <ReportMetricCard
          title="Expiring Soon (< 30 days)"
          value={expiringSoonCount}
          isCurrency={false}
          isCount
          icon={Calendar}
          accent="bg-amber-50 text-amber-700"
          valueClassName="text-amber-600"
        />
        <ReportMetricCard
          title="Expired Lots"
          value={expiredCount}
          isCurrency={false}
          isCount
          icon={AlertTriangle}
          accent="bg-rose-50 text-rose-700"
          valueClassName="text-rose-600"
        />
      </div>

      <ReportTable
        columns={columns}
        data={batches}
        loading={loading}
        error={error}
        keyExtractor={(r) => r.id}
        page={filters.page || 1}
        limit={filters.limit || 50}
        total={total}
        onPageChange={(page) => setFilters({ ...filters, page })}
      />
    </div>
  );
}

