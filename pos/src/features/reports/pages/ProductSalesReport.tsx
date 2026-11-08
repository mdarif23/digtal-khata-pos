import React, { useState } from "react";
import { reportsApi } from "../api/reports.api";
import { useReportData } from "../hooks/useReportData";
import type { ReportFilters, ProductSalesRow } from "../types/report.types";
import {
  exportToCsv,
  formatCurrency,
  formatNumber,
} from "../utils/reportUtils";
import { ReportHeader } from "../components/ReportHeader";
import { ReportDateFilter } from "../components/ReportDateFilter";
import { ReportTable, type ReportColumn } from "../components/ReportTable";
import { ReportBarChart } from "../components/ReportChart";

export function ProductSalesReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
    page: 1,
    limit: 50,
  });

  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getProductSales(filters),
    [filters]
  );

  const products = data?.data || [];
  const total = data?.total || 0;

  const topProductsChart = products.slice(0, 10).map((p) => {
    const label = p.variantName || p.productName;
    return {
      name: label.length > 20 ? label.slice(0, 20) + "…" : label,
      qtySold: p.qtySold,
      grossSales: p.grossSales,
      profit: p.grossProfit,
    };
  });

  const handleExport = () => {
    const headers = [
      "Product Name",
      "Variant",
      "SKU",
      "Category",
      "Brand",
      "Units Sold",
      "Gross Sales (BDT)",
      "Discounts (BDT)",
      "Net Sales (BDT)",
      "Cost of Goods (BDT)",
      "Gross Profit (BDT)",
      "Margin %",
    ];
    const exportRows = products.map((p) => [
      p.productName,
      p.variantOptions ?? "",
      p.sku,
      p.categoryName,
      p.brandName,
      p.qtySold,
      p.grossSales,
      p.totalDiscount,
      p.netSales,
      p.totalCost,
      p.grossProfit,
      p.profitMargin,
    ]);
    exportToCsv("product-sales-report", headers, exportRows);
  };

  const columns: ReportColumn<ProductSalesRow>[] = [
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
      key: "categoryName",
      header: "Category",
      render: (r) => (
        <span className="text-xs rounded-md bg-slate-100 px-2 py-0.5 text-slate-600">
          {r.categoryName}
        </span>
      ),
    },
    {
      key: "qtySold",
      header: "Units Sold",
      render: (r) => (
        <span className="font-semibold text-slate-900">
          {formatNumber(r.qtySold)}
          {r.unitLabel ? (
            <span className="ml-1 text-xs font-normal text-slate-500">
              {r.unitLabel}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "grossSales",
      header: "Gross Sales",
      render: (r) => formatCurrency(r.grossSales),
    },
    {
      key: "netSales",
      header: "Net Sales",
      render: (r) => (
        <span className="font-medium text-slate-950">
          {formatCurrency(r.netSales)}
        </span>
      ),
    },
    {
      key: "totalCost",
      header: "Cost (COGS)",
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
      header: "Margin",
      render: (r) => (
        <span
          className={`font-medium ${
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
        category="Sales Reports"
        title="Product & Variant Sales"
        description="Performance of individual products, units sold, historical cost, and gross margins."
        onExport={handleExport}
        onRefresh={refetch}
        loading={loading}
      />

      <ReportDateFilter
        filters={filters}
        onFiltersChange={setFilters}
        showSearch
        searchPlaceholder="Search product name or SKU..."
      />

      {/* Top 10 Chart */}
      {topProductsChart.length > 0 && (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
          <h3 className="text-base font-semibold text-slate-900 mb-4">
            Top Selling Products by Revenue
          </h3>
          <ReportBarChart
            data={topProductsChart}
            xKey="name"
            bars={[
              { key: "grossSales", name: "Gross Sales", color: "#0284c7" },
              { key: "profit", name: "Gross Profit", color: "#059669" },
            ]}
          />
        </div>
      )}

      {/* Products Table */}
      <ReportTable
        columns={columns}
        data={products}
        loading={loading}
        error={error}
        keyExtractor={(r) => `${r.productId}-${r.sku}`}
        page={filters.page || 1}
        limit={filters.limit || 50}
        total={total}
        onPageChange={(page) => setFilters({ ...filters, page })}
      />
    </div>
  );
}

