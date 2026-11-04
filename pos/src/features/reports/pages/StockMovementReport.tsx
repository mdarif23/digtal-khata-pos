import React, { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, RefreshCw } from "lucide-react";
import { reportsApi } from "../api/reports.api";
import { useReportData } from "../hooks/useReportData";
import type { ReportFilters, StockMovementRow } from "../types/report.types";
import {
  exportToCsv,
  formatDateTime,
  formatNumber,
} from "../utils/reportUtils";
import { ReportHeader } from "../components/ReportHeader";
import { ReportDateFilter } from "../components/ReportDateFilter";
import { ReportTable, type ReportColumn } from "../components/ReportTable";

export function StockMovementReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
    page: 1,
    limit: 50,
  });

  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getStockMovements(filters),
    [filters]
  );

  const movements = data?.data || [];
  const total = data?.total || 0;

  const handleExport = () => {
    const headers = [
      "Movement ID",
      "Date",
      "Product Name",
      "Variant",
      "SKU",
      "Movement Type",
      "Quantity Changed",
      "Reference Type",
      "Reference ID",
    ];
    const exportRows = movements.map((m) => [
      m.id,
      m.createdAt,
      m.productName,
      m.variantOptions ?? "",
      m.sku,
      m.movementType,
      m.quantity,
      m.referenceType,
      m.referenceId,
    ]);
    exportToCsv("stock-movement-report", headers, exportRows);
  };

  const columns: ReportColumn<StockMovementRow>[] = [
    {
      key: "createdAt",
      header: "Timestamp",
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
      key: "movementType",
      header: "Action / Type",
      render: (r) => {
        const isPositive =
          r.movementType === "purchase" ||
          r.movementType === "return" ||
          r.movementType === "transfer_in" ||
          r.quantity > 0;
        return (
          <span
            className={`inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
              isPositive
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-amber-50 text-amber-700 border-amber-200"
            }`}
          >
            {isPositive ? (
              <ArrowDownLeft className="size-3" />
            ) : (
              <ArrowUpRight className="size-3" />
            )}
            {r.movementType}
          </span>
        );
      },
    },
    {
      key: "quantity",
      header: "Quantity",
      render: (r) => (
        <span
          className={`font-bold ${
            r.quantity > 0 ? "text-emerald-700" : "text-slate-900"
          }`}
        >
          {r.quantity > 0 ? `+${formatNumber(r.quantity)}` : formatNumber(r.quantity)}
        </span>
      ),
    },
    {
      key: "referenceType",
      header: "Reference",
      render: (r) => (
        <span className="text-xs text-slate-500 font-mono">
          {r.referenceType} #{r.referenceId}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <ReportHeader
        category="Inventory Reports"
        title="Stock Movement History"
        description="Full audit trail of stock received, sold, returned, or manually adjusted."
        onExport={handleExport}
        onRefresh={refetch}
        loading={loading}
      />

      <ReportDateFilter filters={filters} onFiltersChange={setFilters} />

      <ReportTable
        columns={columns}
        data={movements}
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

