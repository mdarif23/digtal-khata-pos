import { useState } from "react";
import { reportsApi } from "../api/reports.api";
import { useReportData } from "../hooks/useReportData";
import type { ReportFilters, PurchaseItemRow } from "../types/report.types";
import {
  exportToCsv,
  formatCurrency,
  formatDate,
} from "../utils/reportUtils";
import { ReportHeader } from "../components/ReportHeader";
import { ReportDateFilter } from "../components/ReportDateFilter";
import { ReportTable, type ReportColumn } from "../components/ReportTable";

export function PurchaseItemsReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
    page: 1,
    limit: 50,
  });

  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getPurchaseItems(filters),
    [filters]
  );

  const purchaseItems = data?.data || [];
  const total = data?.total || 0;

  const handleExport = () => {
    const headers = [
      "PO Number",
      "Purchase Date",
      "Supplier",
      "Product Name",
      "Variant",
      "SKU",
      "Category",
      "Qty Ordered",
      "Qty Received",
      "Unit Cost (BDT)",
      "Discount (BDT)",
      "Tax (BDT)",
      "Line Total (BDT)",
    ];
    const exportRows = purchaseItems.map((r) => [
      r.purchaseOrderNumber,
      r.purchaseDate,
      r.supplierName,
      r.productName,
      r.variantOptions ?? "",
      r.sku,
      r.categoryName,
      r.quantityOrdered,
      r.quantityReceived,
      r.unitCost,
      r.discount,
      r.tax,
      r.lineTotal,
    ]);
    exportToCsv("purchase-items-report", headers, exportRows);
  };

  const columns: ReportColumn<PurchaseItemRow>[] = [
    {
      key: "purchaseOrderNumber",
      header: "PO",
      render: (r) => (
        <div>
          <p className="font-medium text-slate-900">{r.purchaseOrderNumber}</p>
          <p className="text-xs text-slate-400">{formatDate(r.purchaseDate)}</p>
        </div>
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
      key: "supplierName",
      header: "Supplier",
      render: (r) => <span className="text-slate-700">{r.supplierName}</span>,
    },
    {
      key: "quantityOrdered",
      header: "Qty Ordered",
      render: (r) => (
        <span className="font-semibold text-slate-900">
          {r.quantityOrdered}
        </span>
      ),
    },
    {
      key: "quantityReceived",
      header: "Qty Received",
      render: (r) => <span className="text-slate-700">{r.quantityReceived}</span>,
    },
    {
      key: "unitCost",
      header: "Unit Cost",
      render: (r) => formatCurrency(r.unitCost),
    },
    {
      key: "lineTotal",
      header: "Line Total",
      render: (r) => (
        <span className="font-semibold text-slate-950">
          {formatCurrency(r.lineTotal)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <ReportHeader
        category="Purchase Reports"
        title="Purchase Items"
        description="Variant-level purchase lines with historical unit costs, per order and supplier."
        onExport={handleExport}
        onRefresh={refetch}
        loading={loading}
      />

      <ReportDateFilter filters={filters} onFiltersChange={setFilters} />

      <ReportTable
        columns={columns}
        data={purchaseItems}
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
