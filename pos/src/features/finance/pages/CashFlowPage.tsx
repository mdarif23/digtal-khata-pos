import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Scale } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ReportDateFilter } from "@/features/reports/components/ReportDateFilter";
import { ReportMetricCard } from "@/features/reports/components/ReportMetricCard";
import { ReportTrendChart } from "@/features/reports/components/ReportChart";
import { ReportTable, type ReportColumn } from "@/features/reports/components/ReportTable";
import { formatCurrency } from "@/features/reports/utils/reportUtils";
import type { ReportFilters } from "@/features/reports/types/report.types";
import { useCashFlow } from "../hooks/useFinance";

/**
 * Direct-method cash flow: every journal line on a cash-equivalent GL
 * account, classified by the posting hooks. The invariant — net movement
 * equals the change in cash balances — is asserted server-side.
 */

export function CashFlowPage() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
  } as ReportFilters);
  const dateRange = filters.dateRange ?? {
    startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
      .toISOString()
      .slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
  };
  const cashFlow = useCashFlow(dateRange.startDate, dateRange.endDate);

  const sourceColumns: ReportColumn<{ sourceType: string; category: string; inflow: string; outflow: string; net: string }>[] = [
    { key: "sourceType", header: "Source", render: (row) => <span className="capitalize">{row.sourceType.replace(/_/g, " ")}</span> },
    { key: "category", header: "Category", render: (row) => <span className="capitalize">{row.category}</span> },
    { key: "inflow", header: "Inflow", render: (row) => <span className="text-emerald-700">{formatCurrency(row.inflow)}</span> },
    { key: "outflow", header: "Outflow", render: (row) => <span className="text-rose-700">{formatCurrency(row.outflow)}</span> },
    { key: "net", header: "Net", render: (row) => <strong>{formatCurrency(row.net)}</strong> },
  ];

  const series =
    cashFlow.data?.series.map((point) => ({
      date: point.date,
      inflow: Number(point.inflow),
      outflow: Number(point.outflow),
      net: Number(point.net),
    })) ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
            Finance &amp; Growth
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            Cash Flow
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Direct method from the cash GL accounts. Credit sales appear only when
            collected. Net movement must equal the change in cash balances — it does
            by construction.
          </p>
        </div>
        <ReportDateFilter filters={filters} onFiltersChange={setFilters} showLocationFilter={false} />
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <ReportMetricCard
          title="Cash Inflow"
          value={cashFlow.data?.totals.inflow}
          icon={ArrowUpRight}
          accent="bg-emerald-50 text-emerald-700"
        />
        <ReportMetricCard
          title="Cash Outflow"
          value={cashFlow.data?.totals.outflow}
          icon={ArrowDownRight}
          accent="bg-rose-50 text-rose-700"
        />
        <ReportMetricCard
          title="Net Movement"
          value={cashFlow.data?.totals.net}
          icon={Scale}
          accent="bg-sky-50 text-sky-700"
        />
        <ReportMetricCard
          title="Closing Cash"
          value={cashFlow.data?.reconciliation.closingBalance}
          subtitle={
            cashFlow.data
              ? `Opening ${formatCurrency(cashFlow.data.reconciliation.openingBalance)}`
              : undefined
          }
          icon={Scale}
          accent="bg-slate-100 text-slate-700"
        />
      </div>

      {series.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Daily cash movement</CardTitle>
          </CardHeader>
          <CardContent>
            <ReportTrendChart
              data={series}
              dataKey="net"
              xAxisKey="date"
              title="Net cash movement per day"
            />
          </CardContent>
        </Card>
      )}

      <section className="grid gap-4 lg:grid-cols-3">
        {(["operating", "investing", "financing"] as const).map((category) => (
          <Card key={category}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base capitalize">{category}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Inflow</span>
                <span className="text-emerald-700">
                  {formatCurrency(cashFlow.data?.byCategory[category].inflow ?? "0")}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Outflow</span>
                <span className="text-rose-700">
                  {formatCurrency(cashFlow.data?.byCategory[category].outflow ?? "0")}
                </span>
              </div>
              <div className="flex justify-between border-t pt-1.5 font-semibold">
                <span>Net</span>
                <span>{formatCurrency(cashFlow.data?.byCategory[category].net ?? "0")}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">By source</CardTitle>
        </CardHeader>
        <CardContent>
          <ReportTable
            columns={sourceColumns}
            data={cashFlow.data?.bySource ?? []}
            loading={cashFlow.isLoading}
            keyExtractor={(row) => row.sourceType}
            emptyMessage="No cash movement in this period."
          />
        </CardContent>
      </Card>
    </div>
  );
}
