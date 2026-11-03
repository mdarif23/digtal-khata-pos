import React, { useState } from "react";
import { DollarSign, Percent, TrendingUp, Layers } from "lucide-react";
import { reportsApi } from "../api/reports.api";
import { useReportData } from "../hooks/useReportData";
import type { ReportFilters, ProfitByCategoryRow } from "../types/report.types";
import {
  exportToCsv,
  formatCurrency,
} from "../utils/reportUtils";
import { ReportHeader } from "../components/ReportHeader";
import { ReportDateFilter } from "../components/ReportDateFilter";
import { ReportMetricCard } from "../components/ReportMetricCard";
import { ReportBarChart } from "../components/ReportChart";
import { ReportTable, type ReportColumn } from "../components/ReportTable";
import { PlanUpgradeCard } from "../components/PlanUpgradeCard";

export function ProfitReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
  });

  const { data, loading, error, entitlementError, refetch } = useReportData(
    () => reportsApi.getProfit(filters),
    [filters]
  );

  const categories = data?.categories || [];
  const totals = data?.totals;

  const chartData = categories.map((c) => ({
    name: c.categoryName,
    netSales: c.netSales,
    profit: c.grossProfit,
  }));

  const handleExport = () => {
    const headers = [
      "Category",
      "Net Sales (BDT)",
      "Cost of Goods (BDT)",
      "Gross Profit (BDT)",
      "Gross Margin %",
    ];
    const exportRows = categories.map((c) => [
      c.categoryName,
      c.netSales,
      c.totalCost,
      c.grossProfit,
      c.profitMargin,
    ]);
    exportToCsv("profitability-report", headers, exportRows);
  };

  const columns: ReportColumn<ProfitByCategoryRow>[] = [
    {
      key: "categoryName",
      header: "Category",
      render: (r) => (
        <span className="font-semibold text-slate-900">{r.categoryName}</span>
      ),
    },
    {
      key: "netSales",
      header: "Net Sales",
      render: (r) => formatCurrency(r.netSales),
    },
    {
      key: "totalCost",
      header: "Cost of Goods (COGS)",
      render: (r) => (
        <span className="text-slate-500">{formatCurrency(r.totalCost)}</span>
      ),
    },
    {
      key: "grossProfit",
      header: "Gross Profit",
      render: (r) => (
        <span className="font-semibold text-emerald-700">
          {formatCurrency(r.grossProfit)}
        </span>
      ),
    },
    {
      key: "profitMargin",
      header: "Gross Margin",
      render: (r) => (
        <span
          className={`font-semibold ${
            r.profitMargin >= 30
              ? "text-emerald-700"
              : r.profitMargin >= 15
              ? "text-sky-700"
              : "text-amber-700"
          }`}
        >
          {r.profitMargin}%
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <ReportHeader
        category="Financial Reports"
        title="Gross Profit & Margin Analysis"
        description="Category-level profitability calculated using accurate historical cost (cost_at_sale)."
        onExport={handleExport}
        onRefresh={refetch}
        loading={loading}
      />

      <ReportDateFilter filters={filters} onFiltersChange={setFilters} />

      {entitlementError && <PlanUpgradeCard gate={entitlementError} />}

      {/* Metric Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReportMetricCard
          title="Total Net Sales"
          value={totals?.totalNetSales}
          icon={DollarSign}
          accent="bg-sky-50 text-sky-700"
        />
        <ReportMetricCard
          title="Cost of Goods Sold"
          value={totals?.totalCost}
          icon={Layers}
          accent="bg-slate-100 text-slate-700"
        />
        <ReportMetricCard
          title="Total Gross Profit"
          value={totals?.totalGrossProfit}
          icon={TrendingUp}
          accent="bg-emerald-50 text-emerald-700"
          valueClassName="text-emerald-700"
        />
        <ReportMetricCard
          title="Overall Gross Margin"
          value={totals?.overallMargin}
          isCurrency={false}
          isPercentage
          icon={Percent}
          accent="bg-violet-50 text-violet-700"
        />
      </div>

      {/* Profit Comparison Chart */}
      {chartData.length > 0 && (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
          <h3 className="text-base font-semibold text-slate-900 mb-4">
            Category Profitability Comparison
          </h3>
          <ReportBarChart
            data={chartData}
            xKey="name"
            bars={[
              { key: "netSales", name: "Net Sales", color: "#0284c7" },
              { key: "profit", name: "Gross Profit", color: "#059669" },
            ]}
          />
        </div>
      )}

      {/* Category Table */}
      <ReportTable
        columns={columns}
        data={categories}
        loading={loading}
        error={error}
        keyExtractor={(r) => r.categoryName}
      />
    </div>
  );
}

