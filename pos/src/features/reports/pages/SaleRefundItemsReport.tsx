import { useState } from "react";
import { reportsApi } from "../api/reports.api";
import { useReportData } from "../hooks/useReportData";
import type { ReportFilters, RefundItemRow } from "../types/report.types";
import {
  exportToCsv,
  formatCurrency,
  formatDateTime,
} from "../utils/reportUtils";
import { ReportHeader } from "../components/ReportHeader";
import { ReportDateFilter } from "../components/ReportDateFilter";
import { ReportTable, type ReportColumn } from "../components/ReportTable";

export function SaleRefundItemsReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
    page: 1,
    limit: 50,
  });

  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getSaleRefundItems(filters),
    [filters]
  );

  const refundItems = data?.data || [];
  const total = data?.total || 0;

  const handleExport = () => {
    const headers = [
      "Refund ID",
      "Date",
      "Original Invoice",
      "Customer",
      "Product Name",
      "Variant",
      "SKU",
      "Quantity Returned",
      "Refund Price (BDT)",
      "Refund Total (BDT)",
      "Disposition",
    ];
    const exportRows = refundItems.map((r) => [
      r.refundId,
      r.refundedAt,
      r.invoiceNumber,
      r.customerName,
      r.productName,
      r.variantOptions ?? "",
      r.sku,
      r.quantityReturned,
      r.refundPrice,
      r.refundTotal,
      r.disposition,
    ]);
    exportToCsv("sales-refund-items-report", headers, exportRows);
  };

  const columns: ReportColumn<RefundItemRow>[] = [
    {
      key: "refundedAt",
      header: "Date",
      render: (r) => (
        <span className="text-xs text-slate-500">
          {formatDateTime(r.refundedAt)}
        </span>
      ),
    },
    {
      key: "invoiceNumber",
      header: "Invoice",
      render: (r) => (
        <span className="font-medium text-slate-900">{r.invoiceNumber}</span>
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
      key: "customerName",
      header: "Customer",
      render: (r) => <span className="text-slate-700">{r.customerName}</span>,
    },
    {
      key: "quantityReturned",
      header: "Qty Returned",
      render: (r) => (
        <span className="font-semibold text-slate-900">
          {r.quantityReturned}
        </span>
      ),
    },
    {
      key: "refundTotal",
      header: "Refund Amount",
      render: (r) => (
        <span className="font-semibold text-rose-600">
          {formatCurrency(r.refundTotal)}
        </span>
      ),
    },
    {
      key: "disposition",
      header: "Disposition",
      render: (r) => (
        <span className="text-xs uppercase tracking-wide text-slate-500">
          {r.disposition}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <ReportHeader
        category="Sales Reports"
        title="Returned Items"
        description="Variant-level detail of every refunded line, with quantities and refund money."
        onExport={handleExport}
        onRefresh={refetch}
        loading={loading}
      />

      <ReportDateFilter filters={filters} onFiltersChange={setFilters} />

      <ReportTable
        columns={columns}
        data={refundItems}
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
