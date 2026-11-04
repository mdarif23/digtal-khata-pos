import React, { useState } from "react";
import { Package, AlertTriangle, Layers, DollarSign } from "lucide-react";
import { reportsApi } from "../api/reports.api";
import { useReportData } from "../hooks/useReportData";
import type { ReportFilters, StockRow } from "../types/report.types";
import {
  exportToCsv,
  formatCurrency,
  formatNumber,
} from "../utils/reportUtils";
import { ReportHeader } from "../components/ReportHeader";
import { ReportDateFilter } from "../components/ReportDateFilter";
import { ReportMetricCard } from "../components/ReportMetricCard";
import { ReportTable, type ReportColumn } from "../components/ReportTable";
import { StatusBadge } from "../components/StatusBadge";

export function StockReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
    page: 1,
    limit: 50,
  });

  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getStock(filters),
    [filters]
  );

  const stockRows = data?.data || [];
  const valuation = data?.valuation;
  const total = data?.total || 0;

  const lowStockCount = stockRows.filter(
    (r) => r.stockStatus === "low_stock"
  ).length;
  const outOfStockCount = stockRows.filter(
    (r) => r.stockStatus === "out_of_stock"
  ).length;

  const handleExport = () => {
    const headers = [
      "Product Name",
      "Variant",
      "SKU",
      "Barcode",
      "Category",
      "Brand",
      "Current Stock",
      "Alert Quantity",
      "Selling Price (BDT)",
      "Stock Value (BDT)",
      "Status",
    ];
    const exportRows = stockRows.map((r) => [
      r.productName,
      r.variantOptions ?? "",
      r.sku,
      r.barcode,
      r.categoryName,
      r.brandName,
      r.currentStock,
      r.alertQuantity,
      r.sellingPrice,
      r.stockValue,
      r.stockStatus,
    ]);
    exportToCsv("inventory-stock-report", headers, exportRows);
  };

  const columns: ReportColumn<StockRow>[] = [
    {
      key: "productName",
      header: "Product & Variant",
      render: (r) => (
        <div>
          <p className="font-semibold text-slate-900">{r.productName}</p>
          {r.variantOptions ? (
            <p className="text-xs text-slate-500">{r.variantOptions}</p>
          ) : null}
          <p className="text-xs text-slate-400 font-mono">
            SKU: {r.sku} {r.barcode !== "-" ? `| ${r.barcode}` : ""}
          </p>
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
      key: "currentStock",
      header: "Available Stock",
      render: (r) => (
        <span
          className={`font-bold ${
            r.currentStock <= 0
              ? "text-rose-600"
              : r.currentStock <= r.alertQuantity
              ? "text-amber-600"
              : "text-slate-900"
          }`}
        >
          {formatNumber(r.currentStock)}
        </span>
      ),
    },
    {
      key: "alertQuantity",
      header: "Alert Level",
      render: (r) => formatNumber(r.alertQuantity),
    },
    {
      key: "sellingPrice",
      header: "Selling Price",
      render: (r) => formatCurrency(r.sellingPrice),
    },
    {
      key: "stockValue",
      header: "Valuation (Cost)",
      render: (r) => (
        <span className="font-semibold text-slate-900">
          {formatCurrency(r.stockValue)}
        </span>
      ),
    },
    {
      key: "stockStatus",
      header: "Stock Status",
      render: (r) => <StatusBadge status={r.stockStatus} />,
    },
  ];

  return (
    <div className="space-y-6">
      <ReportHeader
        category="Inventory Reports"
        title="Current Stock & Valuation"
        description="Real-time physical stock counts, batch-costed valuation, and stock alerts."
        onExport={handleExport}
        onRefresh={refetch}
        loading={loading}
      />

      <ReportDateFilter
        filters={filters}
        onFiltersChange={setFilters}
        showSearch
        searchPlaceholder="Search product, SKU, or barcode..."
      />

      {/* Summary Metrics */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReportMetricCard
          title="Total Stock Valuation"
          value={valuation?.totalValuation}
          icon={DollarSign}
          accent="bg-emerald-50 text-emerald-700"
          valueClassName="text-emerald-700"
        />
        <ReportMetricCard
          title="Total Inventory Units"
          value={valuation?.totalUnits}
          isCurrency={false}
          isCount
          icon={Layers}
          accent="bg-sky-50 text-sky-700"
        />
        <ReportMetricCard
          title="Low Stock Items"
          value={lowStockCount}
          isCurrency={false}
          isCount
          icon={AlertTriangle}
          accent="bg-amber-50 text-amber-700"
          valueClassName="text-amber-600"
        />
        <ReportMetricCard
          title="Out of Stock Items"
          value={outOfStockCount}
          isCurrency={false}
          isCount
          icon={Package}
          accent="bg-rose-50 text-rose-700"
          valueClassName="text-rose-600"
        />
      </div>

      {/* Stock Table */}
      <ReportTable
        columns={columns}
        data={stockRows}
        loading={loading}
        error={error}
        keyExtractor={(r) => r.variantId}
        page={filters.page || 1}
        limit={filters.limit || 50}
        total={total}
        onPageChange={(page) => setFilters({ ...filters, page })}
      />
    </div>
  );
}

