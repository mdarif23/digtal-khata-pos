import React, { useState } from "react";
import { Landmark, ArrowUpRight, ArrowDownLeft, ShieldCheck } from "lucide-react";
import { reportsApi } from "../api/reports.api";
import { useReportData } from "../hooks/useReportData";
import type { ReportFilters, DailyVatRow } from "../types/report.types";
import {
  exportToCsv,
  formatCurrency,
  formatDate,
} from "../utils/reportUtils";
import { ReportHeader } from "../components/ReportHeader";
import { ReportDateFilter } from "../components/ReportDateFilter";
import { ReportMetricCard } from "../components/ReportMetricCard";
import { ReportTable, type ReportColumn } from "../components/ReportTable";
import { PlanUpgradeCard } from "../components/PlanUpgradeCard";

export function TaxReconciliationReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
  });

  const { data, loading, error, entitlementError, refetch } = useReportData(
    () => reportsApi.getTaxReconciliation(filters),
    [filters]
  );

  const salesTax = data?.salesTax;
  const purchaseTax = data?.purchaseTax;
  const netLiability = data?.netTaxLiability ?? 0;
  const dailyBreakdown = data?.dailyBreakdown || [];

  const handleExport = () => {
    const headers = [
      "Date",
      "Taxable Sales (BDT)",
      "Output VAT Collected (BDT)",
      "Taxable Purchases (BDT)",
      "Input VAT Paid (BDT)",
      "Net VAT Liability (BDT)",
    ];
    const exportRows = dailyBreakdown.map((d) => [
      d.reportDate,
      d.taxableSales,
      d.outputVat,
      d.taxablePurchases,
      d.inputVat,
      d.netVatPayable,
    ]);
    exportToCsv("tax-vat-reconciliation-report", headers, exportRows);
  };

  const columns: ReportColumn<DailyVatRow>[] = [
    {
      key: "reportDate",
      header: "Date",
      render: (r) => (
        <span className="font-semibold text-slate-900">
          {formatDate(r.reportDate)}
        </span>
      ),
    },
    {
      key: "taxableSales",
      header: "Taxable Sales",
      render: (r) => formatCurrency(r.taxableSales),
    },
    {
      key: "outputVat",
      header: "Output VAT (Sales)",
      render: (r) => (
        <span className="font-semibold text-emerald-700">
          {formatCurrency(r.outputVat)}
        </span>
      ),
    },
    {
      key: "taxablePurchases",
      header: "Taxable Purchases",
      render: (r) => formatCurrency(r.taxablePurchases),
    },
    {
      key: "inputVat",
      header: "Input VAT (Purchases)",
      render: (r) => (
        <span className="font-semibold text-sky-700">
          {formatCurrency(r.inputVat)}
        </span>
      ),
    },
    {
      key: "netVatPayable",
      header: "Net VAT Payable",
      render: (r) => (
        <span
          className={`font-bold ${
            r.netVatPayable >= 0 ? "text-rose-600" : "text-emerald-700"
          }`}
        >
          {formatCurrency(r.netVatPayable)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <ReportHeader
        category="Financial Reports"
        title="Tax & VAT Reconciliation"
        description="Audit Output VAT collected on sales against Input VAT paid on purchases to calculate net tax payable."
        onExport={handleExport}
        onRefresh={refetch}
        loading={loading}
      />

      <ReportDateFilter filters={filters} onFiltersChange={setFilters} />

      {entitlementError && <PlanUpgradeCard gate={entitlementError} />}

      {/* Summary Metrics */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReportMetricCard
          title="Output VAT (Collected)"
          value={salesTax?.outputVat}
          subtitle={`${salesTax?.taxableInvoices || 0} sales invoices`}
          icon={ArrowUpRight}
          accent="bg-emerald-50 text-emerald-700"
          valueClassName="text-emerald-700"
        />
        <ReportMetricCard
          title="Input VAT (Credit Claimable)"
          value={purchaseTax?.inputVat}
          subtitle={`${purchaseTax?.purchaseOrdersCount || 0} purchase orders`}
          icon={ArrowDownLeft}
          accent="bg-sky-50 text-sky-700"
          valueClassName="text-sky-700"
        />
        <ReportMetricCard
          title="Net Tax Liability"
          value={netLiability}
          subtitle={
            netLiability >= 0
              ? "Payable to Tax Authority / NBR"
              : "Tax Credit Forward"
          }
          icon={Landmark}
          accent="bg-rose-50 text-rose-700"
          valueClassName={netLiability >= 0 ? "text-rose-700" : "text-emerald-700"}
        />
        <ReportMetricCard
          title="Compliance Status"
          value={netLiability >= 0 ? "Tax Due" : "Credit Available"}
          isCurrency={false}
          subtitle="Audit-reconciled"
          icon={ShieldCheck}
          accent="bg-violet-50 text-violet-700"
          valueClassName="text-lg text-slate-900"
        />
      </div>

      {/* Breakdown Table */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-slate-900">
          Daily Tax Transaction Ledger
        </h3>
        <ReportTable
          columns={columns}
          data={dailyBreakdown}
          loading={loading}
          error={error}
          keyExtractor={(r) => r.reportDate}
        />
      </div>
    </div>
  );
}

