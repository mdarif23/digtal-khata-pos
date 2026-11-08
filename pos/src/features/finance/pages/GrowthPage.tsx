import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Lightbulb } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReportMetricCard } from "@/features/reports/components/ReportMetricCard";
import { formatCurrency } from "@/features/reports/utils/reportUtils";
import { useGrowth } from "../hooks/useFinance";
import type { GrowthMetrics } from "../finance.types";

/**
 * Growth Analytics: current vs previous period (preset or custom), every
 * KPI derived from posted ledger entries. Zero denominators render as "—"
 * (insufficient data), never a fabricated percentage.
 */

const PERIOD_OPTIONS = [
  { value: "today", label: "Today vs yesterday" },
  { value: "this_week", label: "This week vs last week" },
  { value: "this_month", label: "This month vs last month" },
  { value: "this_quarter", label: "This quarter vs last quarter" },
  { value: "this_year", label: "This year vs last year" },
];

export function GrowthPage() {
  const [period, setPeriod] = useState("this_month");
  const growth = useGrowth(period, period);

  const current = growth.data?.current;
  const previous = growth.data?.previous;
  const changes = growth.data?.changes;

  const changeBadge = (key: string) => {
    const value = changes?.[key];
    if (value == null) {
      return (
        <Badge variant="outline" className="text-xs text-slate-500">
          insufficient data
        </Badge>
      );
    }
    const up = value >= 0;
    return (
      <Badge
        variant="outline"
        className={`gap-1 text-xs ${up ? "text-emerald-700" : "text-rose-700"}`}
      >
        {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
        {up ? "+" : ""}
        {value}%
      </Badge>
    );
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
            Finance &amp; Growth
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            Business Growth
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Verified figures only — every KPI comes from the posted ledger, with
            rule-based insights. Zero denominators show as insufficient data.
          </p>
        </div>
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIOD_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricWithChange
          title="Net Revenue"
          value={current?.netRevenue}
          previous={previous?.netRevenue}
          change={changes?.netRevenuePercent}
        />
        <MetricWithChange
          title="Gross Profit"
          value={current?.grossProfit}
          previous={previous?.grossProfit}
          change={changes?.grossProfitPercent}
          subtitle={
            current?.grossMarginPercent != null
              ? `${current.grossMarginPercent}% margin`
              : undefined
          }
        />
        <MetricWithChange
          title="Net Profit"
          value={current?.netProfit}
          previous={previous?.netProfit}
          change={changes?.netProfitPercent}
          subtitle={
            current?.netMarginPercent != null
              ? `${current.netMarginPercent}% margin`
              : undefined
          }
        />
        <MetricWithChange
          title="Expenses"
          value={current?.expensesTotal}
          previous={previous?.expensesTotal}
          change={changes?.expensesPercent}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricWithChange
          title="Sales Count"
          value={current?.salesCount}
          previous={previous?.salesCount}
          change={changes?.salesCountPercent}
          isCount
        />
        <MetricWithChange
          title="Avg Order Value"
          value={current?.averageOrderValue}
          previous={previous?.averageOrderValue}
          change={changes?.averageOrderValuePercent}
        />
        <MetricWithChange
          title="New Customers"
          value={current?.newCustomers}
          previous={previous?.newCustomers}
          change={changes?.newCustomersPercent}
          isCount
        />
        <ReportMetricCard
          title="Employee Cost Ratio"
          value={current?.employeeCostRatioPercent}
          isPercentage
          subtitle={current ? `Salaries ${formatCurrency(current.employeeCost)}` : undefined}
          accent="bg-amber-50 text-amber-700"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Inventory efficiency</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Turnover (period)</span>
              <span>{current?.inventoryTurnover != null ? `${current.inventoryTurnover}×` : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Stock holding days</span>
              <span>
                {current?.stockHoldingDays != null ? `${current.stockHoldingDays} days` : "—"}
              </span>
            </div>
            <p className="pt-1 text-xs text-slate-400">
              Point-in-time batch valuation approximation.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Return on invested capital</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">ROIC (annualized)</span>
              <span>
                {current?.returnOnInvestedCapitalPercent != null
                  ? `${current.returnOnInvestedCapitalPercent}%`
                  : "—"}
              </span>
            </div>
            <p className="pt-1 text-xs text-slate-400">
              Net profit annualized over owner position + loans.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-base">
              <Lightbulb className="size-4 text-amber-500" /> Insights
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {(growth.data?.insights ?? []).length === 0 && (
              <p className="text-slate-400">No notable signals for this period.</p>
            )}
            {(growth.data?.insights ?? []).map((insight, index) => (
              <div key={index} className="rounded-xl border border-slate-200 px-3 py-2">
                <Badge
                  variant="outline"
                  className={`mb-1 text-xs ${
                    insight.type === "positive"
                      ? "text-emerald-700"
                      : "text-amber-700"
                  }`}
                >
                  {insight.type}
                </Badge>
                <p className="text-slate-800">{insight.message}</p>
                <p className="mt-0.5 text-xs text-slate-400">{insight.evidence}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {current?.partial && (
        <p className="text-xs text-slate-400">
          The current period is still in progress — comparisons reflect partial data.
        </p>
      )}
    </div>
  );
}

function MetricWithChange({
  title,
  value,
  previous,
  change,
  subtitle,
  isCount,
}: {
  title: string;
  value?: string | number;
  previous?: string | number;
  change?: number | null;
  subtitle?: string;
  isCount?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-slate-500">{title}</p>
        {changeBadge(change)}
      </div>
      <p className="mt-1.5 text-xl font-semibold text-slate-950">
        {isCount ? (value ?? "—") : formatCurrency(value as string | undefined)}
      </p>
      <p className="mt-0.5 text-xs text-slate-400">
        Previous:{" "}
        {isCount ? (previous ?? "—") : formatCurrency(previous as string | undefined)}
        {subtitle ? ` · ${subtitle}` : ""}
      </p>
    </div>
  );
}
