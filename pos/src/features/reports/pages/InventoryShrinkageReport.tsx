import React, { useState } from "react";
import { AlertOctagon, TrendingDown, Layers, FileWarning } from "lucide-react";
import { reportsApi } from "../api/reports.api";
import { useReportData } from "../hooks/useReportData";
import type { ReportFilters, ShrinkageRow } from "../types/report.types";
import {
  exportToCsv,
  formatCurrency,
  formatDateTime,
  formatNumber,
} from "../utils/reportUtils";
import { ReportHeader } from "../components/ReportHeader";
import { ReportDateFilter } from "../components/ReportDateFilter";
import { ReportMetricCard } from "../components/ReportMetricCard";
import { ReportPieChart } from "../components/ReportChart";
import { ReportTable, type ReportColumn } from "../components/ReportTable";

export function InventoryShrinkageReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
    page: 1,
    limit: 50,
  });

  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getInventoryShrinkage(filters),
    [filters]
  );

  const incidents = data?.incidents || [];
  const summary = data?.summary;
  const byReason = data?.byReason || [];
  const total = data?.total || 0;

  const chartData = byReason.map((r) => ({
    name: r.reason.replace(/_/g, " ").toUpperCase(),
    value: Number(r.costLoss),
  }));

  const handleExport = () => {
    const headers = [
      "Date",
      "Product Name",
      "Variant",
      "SKU",
      "Category",
      "Shrinkage Reason",
      "Units Lost",
      "Unit Cost (BDT)",
      "Financial Cost Loss (BDT)",
      "Lost Retail Revenue (BDT)",
    ];
    const exportRows = incidents.map((i) => [
      i.createdAt,
      i.productName,
      i.variantOptions ?? "",
      i.sku,
      i.categoryName,
      i.reason,
      i.unitsLost,
      i.unitCost,
      i.costLoss,
      i.retailLoss,
    ]);
    exportToCsv("inventory-shrinkage-loss-report", headers, exportRows);
  };

  const columns: ReportColumn<ShrinkageRow>[] = [
    {
      key: "createdAt",
      header: "Incident Date",
      render: (r) => (
        <span className="text-xs text-slate-500">
          {formatDateTime(r.createdAt)}
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
      key: "reason",
      header: "Reason Code",
      render: (r) => {
        const isDamaged = r.reason === "damaged";
        const isExpired = r.reason === "expired";
        const isLost = r.reason === "lost";
        return (
          <span
            className={`inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider px-2.5 py-0.5 rounded-full border ${
              isDamaged
                ? "bg-rose-50 text-rose-700 border-rose-200"
                : isExpired
                ? "bg-amber-50 text-amber-700 border-amber-200"
                : isLost
                ? "bg-primary/10 text-primary border-primary/30"
                : "bg-slate-100 text-slate-700 border-slate-200"
            }`}
          >
            <AlertOctagon className="size-3" />
            {r.reason}
          </span>
        );
      },
    },
    {
      key: "unitsLost",
      header: "Units Lost",
      render: (r) => (
        <span className="font-bold text-rose-600">
          -{formatNumber(r.unitsLost)}
        </span>
      ),
    },
    {
      key: "costLoss",
      header: "Cost Loss (COGS)",
      render: (r) => (
        <span className="font-semibold text-slate-900">
          {formatCurrency(r.costLoss)}
        </span>
      ),
    },
    {
      key: "retailLoss",
      header: "Retail Loss",
      render: (r) => (
        <span className="text-slate-500 font-medium">
          {formatCurrency(r.retailLoss)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <ReportHeader
        category="Inventory Reports"
        title="Inventory Loss & Shrinkage"
        description="Damaged, expired, lost, and discrepancy stock adjustments with cost impact."
        onExport={handleExport}
        onRefresh={refetch}
        loading={loading}
      />

      <ReportDateFilter filters={filters} onFiltersChange={setFilters} />

      {/* Metrics Row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReportMetricCard
          title="Total Cost Loss"
          value={summary?.totalCostLoss}
          subtitle="Net wholesale capital lost"
          icon={TrendingDown}
          accent="bg-rose-50 text-rose-700"
          valueClassName="text-rose-700"
        />
        <ReportMetricCard
          title="Lost Retail Value"
          value={summary?.totalRetailLoss}
          subtitle="Potential revenue unearned"
          icon={FileWarning}
          accent="bg-amber-50 text-amber-700"
        />
        <ReportMetricCard
          title="Total Units Lost"
          value={summary?.totalUnitsLost}
          isCurrency={false}
          isCount
          icon={Layers}
          accent="bg-violet-50 text-violet-700"
        />
        <ReportMetricCard
          title="Shrinkage Incidents"
          value={summary?.incidentCount}
          isCurrency={false}
          isCount
          icon={AlertOctagon}
          accent="bg-slate-100 text-slate-700"
        />
      </div>

      {/* Shrinkage Reason Breakdown */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs lg:col-span-1">
          <h3 className="text-base font-semibold text-slate-900 mb-2">
            Loss by Reason
          </h3>
          <ReportPieChart data={chartData} />
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs lg:col-span-2">
          <h3 className="text-base font-semibold text-slate-900 mb-4">
            Shrinkage Reasons Breakdown
          </h3>
          <div className="space-y-3">
            {byReason.map((br) => (
              <div
                key={br.reason}
                className="flex items-center justify-between border-b border-slate-100 pb-2.5 last:border-0"
              >
                <div>
                  <p className="text-sm font-semibold capitalize text-slate-800">
                    {br.reason.replace(/_/g, " ")}
                  </p>
                  <p className="text-xs text-slate-400">
                    {br.incidentCount} adjustments · {br.unitsLost} units removed
                  </p>
                </div>
                <span className="font-bold text-rose-600">
                  {formatCurrency(br.costLoss)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Incidents Table */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-slate-900">
          Adjustment Incident Log
        </h3>
        <ReportTable
          columns={columns}
          data={incidents}
          loading={loading}
          error={error}
          keyExtractor={(r) => r.id}
          page={filters.page || 1}
          limit={filters.limit || 50}
          total={total}
          onPageChange={(page) => setFilters({ ...filters, page })}
        />
      </div>
    </div>
  );
}

