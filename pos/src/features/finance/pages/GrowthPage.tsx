import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Lightbulb } from "lucide-react";
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
import { StatusBadge } from "@/components/common/StatusBadge";
import { SummaryCard } from "@/components/common/SummaryCard";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { formatCurrency } from "@/lib/format";
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

/** Change badge from a raw percentage — module scope so the MetricWithChange
 * helper can use it (a nested definition was unreachable from it and crashed
 * the whole page with "changeBadge is not defined"). */
function renderChangeBadge(value: number | null | undefined) {
  if (value == null) {
    return <StatusBadge tone="neutral">insufficient data</StatusBadge>;
  }
  const up = value >= 0;
  return (
    <StatusBadge tone={up ? "success" : "danger"} dot={false} className="gap-1">
      {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
      {up ? "+" : ""}
      {value}%
    </StatusBadge>
  );
}

export function GrowthPage() {
  const [period, setPeriod] = useState("this_month");
  const growth = useGrowth(period, period);

  const current = growth.data?.current;
  const previous = growth.data?.previous;
  const changes = growth.data?.changes;

  return (
    <PageContainer>
      <PageHeader
        title="Business Growth"
        description="Verified figures only — every KPI comes from the posted ledger, with rule-based insights. Zero denominators show as insufficient data."
        actions={
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
        }
      />

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
        <SummaryCard
          title="Employee Cost Ratio"
          value={
            current?.employeeCostRatioPercent != null
              ? `${Number(current.employeeCostRatioPercent).toFixed(2)}%`
              : "—"
          }
          description={current ? `Salaries ${formatCurrency(current.employeeCost)}` : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Inventory efficiency</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Turnover (period)</span>
              <span>{current?.inventoryTurnover != null ? `${current.inventoryTurnover}×` : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Stock holding days</span>
              <span>
                {current?.stockHoldingDays != null ? `${current.stockHoldingDays} days` : "—"}
              </span>
            </div>
            <p className="pt-1 text-xs text-muted-foreground">
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
              <span className="text-muted-foreground">ROIC (annualized)</span>
              <span>
                {current?.returnOnInvestedCapitalPercent != null
                  ? `${current.returnOnInvestedCapitalPercent}%`
                  : "—"}
              </span>
            </div>
            <p className="pt-1 text-xs text-muted-foreground">
              Net profit annualized over owner position + loans.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-base">
              <Lightbulb className="size-4 text-warning" /> Insights
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {(growth.data?.insights ?? []).length === 0 && (
              <p className="text-muted-foreground">No notable signals for this period.</p>
            )}
            {(growth.data?.insights ?? []).map((insight, index) => (
              <div key={index} className="rounded-xl border px-3 py-2">
                <div className="mb-1">
                  <StatusBadge tone={insight.type === "positive" ? "success" : "warning"}>
                    {insight.type}
                  </StatusBadge>
                </div>
                <p className="text-foreground">{insight.message}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{insight.evidence}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {current?.partial && (
        <p className="text-xs text-muted-foreground">
          The current period is still in progress — comparisons reflect partial data.
        </p>
      )}
    </PageContainer>
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
  value?: string | number | undefined;
  previous?: string | number | undefined;
  change?: number | null | undefined;
  subtitle?: string | undefined;
  isCount?: boolean;
}) {
  return (
    <SummaryCard
      title={title}
      value={isCount ? (value ?? "—") : formatCurrency(value)}
      icon={renderChangeBadge(change)}
      description={
        <>
          Previous: {isCount ? (previous ?? "—") : formatCurrency(previous)}
          {subtitle ? ` · ${subtitle}` : ""}
        </>
      }
    />
  );
}
