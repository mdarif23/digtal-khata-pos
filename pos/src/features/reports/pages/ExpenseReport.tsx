import React, { useState } from "react";
import { Receipt, Tag, TrendingDown } from "lucide-react";
import { reportsApi } from "../api/reports.api";
import { useReportData } from "../hooks/useReportData";
import type { ReportFilters, ExpenseRow } from "../types/report.types";
import {
  exportToCsv,
  formatCurrency,
  formatDate,
  formatNumber,
} from "../utils/reportUtils";
import { ReportHeader } from "../components/ReportHeader";
import { ReportDateFilter } from "../components/ReportDateFilter";
import { ReportMetricCard } from "../components/ReportMetricCard";
import { ReportPieChart } from "../components/ReportChart";
import { ReportTable, type ReportColumn } from "../components/ReportTable";

export function ExpenseReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
    page: 1,
    limit: 50,
  });

  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getExpenses(filters),
    [filters]
  );

  const expenses = data?.data || [];
  const categoryTotals = data?.categoryTotals || [];
  const grandTotal = data?.summary?.grandTotal || 0;
  const totalCount = data?.summary?.totalCount || 0;
  const total = data?.total || 0;

  const chartData = categoryTotals.map((c) => ({
    name: c.categoryName,
    value: Number(c.totalAmount),
  }));

  const handleExport = () => {
    const headers = [
      "Expense Date",
      "Title",
      "Category",
      "Amount (BDT)",
      "Payment Method",
      "Reference No",
      "Note",
    ];
    const exportRows = expenses.map((e) => [
      e.expenseDate,
      e.title,
      e.categoryName,
      e.amount,
      e.paymentMethod,
      e.referenceNo,
      e.note,
    ]);
    exportToCsv("expense-report", headers, exportRows);
  };

  const columns: ReportColumn<ExpenseRow>[] = [
    {
      key: "expenseDate",
      header: "Date",
      render: (r) => (
        <span className="text-slate-600 text-xs font-medium">
          {formatDate(r.expenseDate)}
        </span>
      ),
    },
    {
      key: "title",
      header: "Expense Title",
      render: (r) => (
        <div>
          <p className="font-semibold text-slate-900">{r.title}</p>
          {r.note && <p className="text-xs text-slate-400">{r.note}</p>}
        </div>
      ),
    },
    {
      key: "categoryName",
      header: "Category",
      render: (r) => (
        <span className="text-xs rounded-md bg-primary/10 text-primary px-2 py-0.5 border border-primary/30">
          {r.categoryName}
        </span>
      ),
    },
    {
      key: "paymentMethod",
      header: "Payment Method",
      render: (r) => <span className="text-xs text-slate-500">{r.paymentMethod}</span>,
    },
    {
      key: "referenceNo",
      header: "Reference",
      render: (r) => (
        <span className="text-xs font-mono text-slate-500">
          {r.referenceNo || "—"}
        </span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      render: (r) => (
        <span className="font-semibold text-rose-600">
          {formatCurrency(r.amount)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <ReportHeader
        category="Financial Reports"
        title="Expense Summary & Categories"
        description="Operational expenses grouped by category, payment method, and individual records."
        onExport={handleExport}
        onRefresh={refetch}
        loading={loading}
      />

      <ReportDateFilter filters={filters} onFiltersChange={setFilters} />

      {/* Metrics Row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReportMetricCard
          title="Total Operating Expenses"
          value={grandTotal}
          icon={TrendingDown}
          accent="bg-rose-50 text-rose-700"
          valueClassName="text-rose-700"
        />
        <ReportMetricCard
          title="Expense Entries"
          value={totalCount}
          isCurrency={false}
          isCount
          icon={Receipt}
          accent="bg-violet-50 text-violet-700"
        />
        <ReportMetricCard
          title="Expense Categories"
          value={categoryTotals.length}
          isCurrency={false}
          isCount
          icon={Tag}
          accent="bg-sky-50 text-sky-700"
        />
      </div>

      {/* Breakdown by Category & Table */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs lg:col-span-1">
          <h3 className="text-base font-semibold text-slate-900 mb-2">
            Expenses by Category
          </h3>
          <ReportPieChart data={chartData} />
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs lg:col-span-2">
          <h3 className="text-base font-semibold text-slate-900 mb-4">
            Category Breakdown
          </h3>
          <div className="space-y-3">
            {categoryTotals.map((cat) => {
              const pct =
                grandTotal > 0
                  ? (Number(cat.totalAmount) / grandTotal) * 100
                  : 0;
              return (
                <div
                  key={cat.categoryName}
                  className="flex items-center justify-between border-b border-slate-100 pb-2.5 last:border-0"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-800">
                      {cat.categoryName}
                    </p>
                    <p className="text-xs text-slate-400">
                      {cat.expenseCount} transactions ({pct.toFixed(1)}%)
                    </p>
                  </div>
                  <span className="font-semibold text-slate-900">
                    {formatCurrency(cat.totalAmount)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Detailed Expense Log Table */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-slate-900">
          Expense Transaction Log
        </h3>
        <ReportTable
          columns={columns}
          data={expenses}
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

