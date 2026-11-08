import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { ReportDateFilter } from "@/features/reports/components/ReportDateFilter";
import { ReportTable, type ReportColumn } from "@/features/reports/components/ReportTable";
import { formatCurrency } from "@/features/reports/utils/reportUtils";
import type { ReportFilters } from "@/features/reports/types/report.types";
import axios from "axios";
import {
  financeKeys,
} from "../hooks/useFinance";
import {
  getFinanceReportApi,
  getPnlReportApi,
  getRetainedEarningsReportApi,
} from "../finance.api";
import type {
  FinanceReportTable,
  PnlReport,
  RetainedEarningsReport,
} from "../finance.types";

/**
 * Finance Reports hub: the reports from /api/finance/reports/*. P&L and
 * retained earnings get dedicated structured bodies; the rest are tabular.
 * CSV export streams the backend's own ?format=csv response.
 */

type TabKey =
  | "pnl"
  | "owner-investments"
  | "owner-withdrawals"
  | "profit-allocations"
  | "retained-earnings"
  | "payroll"
  | "salary-outstanding"
  | "loan-outstanding"
  | "budget-variance"
  | "transactions";

const TABS: { key: TabKey; title: string }[] = [
  { key: "pnl", title: "Profit & Loss" },
  { key: "owner-investments", title: "Owner Investments" },
  { key: "owner-withdrawals", title: "Owner Withdrawals" },
  { key: "profit-allocations", title: "Profit Allocation" },
  { key: "retained-earnings", title: "Retained Earnings" },
  { key: "payroll", title: "Payroll" },
  { key: "salary-outstanding", title: "Salary Outstanding" },
  { key: "loan-outstanding", title: "Loan Outstanding" },
  { key: "budget-variance", title: "Budget Variance" },
  { key: "transactions", title: "Financial Transactions" },
];

const TABULAR_TABS: FinanceReportTableTab[] = [
  "owner-investments",
  "owner-withdrawals",
  "profit-allocations",
  "payroll",
  "salary-outstanding",
  "loan-outstanding",
  "budget-variance",
  "transactions",
];
type FinanceReportTableTab = Exclude<TabKey, "pnl" | "retained-earnings">;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function FinanceReportsPage() {
  const [tab, setTab] = useState<TabKey>("pnl");
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
  } as ReportFilters);
  const dateRange = filters.dateRange ?? {
    startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
      .toISOString()
      .slice(0, 10),
    endDate: todayIso(),
  };
  const from = dateRange.startDate;
  const to = dateRange.endDate;

  const pnl = useQuery({
    queryKey: [...financeKeys.report("pnl"), from, to],
    queryFn: () => getPnlReportApi(from, to),
    enabled: tab === "pnl",
  });
  const retained = useQuery({
    queryKey: [...financeKeys.report("retained-earnings"), from, to],
    queryFn: () => getRetainedEarningsReportApi(from, to),
    enabled: tab === "retained-earnings",
  });
  const table = useQuery({
    queryKey: [...financeKeys.report(tab), from, to],
    queryFn: () => getFinanceReportApi(tab as FinanceReportTableTab, from, to),
    enabled: (TABULAR_TABS as string[]).includes(tab),
  });

  const loading =
    (tab === "pnl" && pnl.isLoading) ||
    (tab === "retained-earnings" && retained.isLoading) ||
    ((TABULAR_TABS as string[]).includes(tab) && table.isLoading);

  const downloadCsv = async () => {
    const response = await axios.get(`/finance/reports/${tab}`, {
      params: { format: "csv", from, to },
      responseType: "blob",
    });
    const url = URL.createObjectURL(response.data as Blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${tab}-${from}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
            Finance &amp; Growth
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            Finance Reports
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Every report derives from posted ledger entries — CSV exports come from
            the same figures.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <ReportDateFilter
            filters={filters}
            onFiltersChange={setFilters}
            showLocationFilter={false}
          />
          <Button variant="outline" onClick={downloadCsv}>
            <Download className="size-4" /> CSV
          </Button>
        </div>
      </header>

      <nav className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={
              t.key === tab
                ? "rounded-full bg-slate-900 px-3 py-1.5 text-xs font-medium text-white"
                : "rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            }
          >
            {t.title}
          </button>
        ))}
      </nav>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner className="size-6" />
        </div>
      ) : tab === "pnl" ? (
        <PnlBody report={pnl.data} />
      ) : tab === "retained-earnings" ? (
        <RetainedBody report={retained.data} />
      ) : (
        <TableBody tab={tab as FinanceReportTableTab} report={table.data} />
      )}
    </div>
  );
}

function PnlBody({ report }: { report: PnlReport | undefined }) {
  if (!report) {
    return <p className="py-16 text-center text-sm text-slate-400">No report data.</p>;
  }
  const lines: { section: string; code: string; name: string; amount: string; total?: boolean }[] =
    [
      ...report.revenue.lines.map((l) => ({
        section: "Revenue",
        code: l.code,
        name: l.name,
        amount: l.balance,
      })),
      { section: "COGS", code: "5010", name: "Cost of goods sold", amount: report.cogs },
      { section: "Totals", code: "", name: "Gross profit", amount: report.grossProfit, total: true },
      ...report.operatingExpenses.lines.map((l) => ({
        section: "Operating expenses",
        code: l.code,
        name: l.name,
        amount: l.balance,
      })),
      {
        section: "Totals",
        code: "",
        name: "Operating profit",
        amount: report.operatingProfit,
        total: true,
      },
      { section: "Below the line", code: "5090", name: "Loan interest", amount: report.interest },
      {
        section: "Totals",
        code: "",
        name: "Net profit",
        amount: report.netProfit,
        total: true,
      },
    ];
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white">
      <div className="divide-y divide-slate-100">
        {lines.map((line, index) => (
          <div
            key={index}
            className={`flex items-center justify-between px-4 py-2.5 text-sm ${
              line.total ? "bg-slate-50 font-semibold" : ""
            }`}
          >
            <span className="text-slate-700">
              {line.code && (
                <span className="mr-2 font-mono text-xs text-slate-400">{line.code}</span>
              )}
              {line.name}
            </span>
            <span className={Number(line.amount) < 0 ? "text-rose-700" : "text-slate-950"}>
              {formatCurrency(line.amount)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RetainedBody({ report }: { report: RetainedEarningsReport | undefined }) {
  if (!report) {
    return <p className="py-16 text-center text-sm text-slate-400">No report data.</p>;
  }
  return (
    <div className="max-w-xl space-y-3">
      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white">
        <div className="divide-y divide-slate-100 text-sm">
          <RowLine label="Opening retained earnings" value={report.openingRetainedEarnings} />
          <RowLine label="Net profit (period)" value={report.netProfit} />
          <RowLine label="Less: profit distributions" value={report.lessProfitDistributions} />
          <div className="flex items-center justify-between bg-slate-50 px-4 py-2.5 font-semibold">
            <span>Closing retained earnings</span>
            <span>{formatCurrency(report.closingRetainedEarnings)}</span>
          </div>
        </div>
      </div>
      <p className="text-xs text-slate-500">{report.note}</p>
    </div>
  );
}

function RowLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-slate-700">{label}</span>
      <span>{formatCurrency(value)}</span>
    </div>
  );
}

const MONEY_KEYS = new Set([
  "amount",
  "budget",
  "actual",
  "variance",
  "earned",
  "paid",
  "outstanding",
  "principal",
  "principalRepaid",
  "interestPaid",
  "debit",
  "credit",
  "grossAmount",
  "netAmount",
  "deductions",
  "invested",
  "withdrawn",
  "distributed",
]);

function renderCell(key: string, row: Record<string, unknown>) {
  const raw = row[key];
  if (typeof raw === "string" && MONEY_KEYS.has(key)) {
    return formatCurrency(raw);
  }
  if (key === "overBudget") {
    return raw ? (
      <Badge variant="outline" className="text-xs text-rose-700">
        Over budget
      </Badge>
    ) : (
      <span className="text-xs text-emerald-600">Within budget</span>
    );
  }
  if (raw === null || raw === undefined || raw === "") {
    return <span className="text-slate-400">—</span>;
  }
  return <span>{String(raw)}</span>;
}

function TableBody({
  tab,
  report,
}: {
  tab: FinanceReportTableTab;
  report: FinanceReportTable | undefined;
}) {
  const columns = (report?.columns ?? []).map(
    (def): ReportColumn<Record<string, unknown>> => ({
      key: def.key,
      header: def.label,
      render: (row) => renderCell(def.key, row),
    }),
  );
  const rows = (report?.rows ?? []) as Record<string, unknown>[];
  return (
    <div className="space-y-3">
      {(report?.total || report?.totalOutstanding || report?.totalAllocated || report?.totalDebit) && (
        <div className="flex flex-wrap gap-2">
          {report?.total && (
            <Badge variant="outline" className="text-xs">
              Total: {formatCurrency(report.total)}
            </Badge>
          )}
          {report?.totalOutstanding && (
            <Badge variant="outline" className="text-xs">
              Outstanding: {formatCurrency(report.totalOutstanding)}
            </Badge>
          )}
          {report?.totalAllocated && (
            <Badge variant="outline" className="text-xs">
              Allocated: {formatCurrency(report.totalAllocated)} · Realized:{" "}
              {formatCurrency(report.totalRealized ?? "0")}
            </Badge>
          )}
          {report?.totalDebit && (
            <Badge
              variant="outline"
              className={
                report.balanced
                  ? "text-xs text-emerald-700"
                  : "text-xs text-amber-700"
              }
            >
              Debits {formatCurrency(report.totalDebit)} = Credits{" "}
              {formatCurrency(report.totalCredit ?? "0")} ·{" "}
              {report.balanced ? "balanced" : "IMBALANCE"}
            </Badge>
          )}
          {report?.truncated && (
            <Badge variant="outline" className="text-xs text-amber-700">
              First 1000 rows — narrow the date range
            </Badge>
          )}
        </div>
      )}
      <ReportTable
        columns={columns}
        data={rows}
        keyExtractor={(row, index) => String(row.id ?? index)}
        emptyMessage={`No ${TABS.find((t) => t.key === tab)?.title.toLowerCase()} records for the selected period.`}
      />
    </div>
  );
}
