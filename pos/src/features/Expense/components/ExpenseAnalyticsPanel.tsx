import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ReportBarChart,
  ReportPieChart,
} from "@/features/reports/components/ReportChart";
import { formatCurrency } from "@/features/reports/utils/reportUtils";
import { cn } from "@/lib/utils";
import {
  useExpenseAnalytics,
  type ExpenseAnalyticsFilters,
} from "../hooks/useExpenses";
import type { ExpenseTrendGranularity } from "../expense.type";

const GRANULARITY_LABELS: Record<ExpenseTrendGranularity, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function bucketLabel(bucket: string, granularity: ExpenseTrendGranularity) {
  if (granularity === "month") {
    const [, month] = bucket.split("-");
    return MONTH_NAMES[Number(month) - 1] ?? bucket;
  }
  return bucket.slice(5);
}

interface ExpenseAnalyticsPanelProps {
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  locationId?: number | undefined;
}

export function ExpenseAnalyticsPanel({
  dateFrom,
  dateTo,
  locationId,
}: ExpenseAnalyticsPanelProps) {
  const [granularity, setGranularity] =
    useState<ExpenseTrendGranularity>("month");
  const filters: ExpenseAnalyticsFilters = {
    dateFrom,
    dateTo,
    granularity,
    locationId,
  };
  const { data, isLoading, isError } = useExpenseAnalytics(filters);

  if (isError) return null; // the list already shows the page-level error state

  const totals = data?.totals;
  const comparison = data?.comparison;
  const categories = data?.categories ?? [];
  const methods = data?.paymentMethods ?? [];
  const locations = data?.locations ?? [];
  const series = (data?.series ?? []).map((point) => ({
    ...point,
    label: bucketLabel(point.bucket, granularity),
  }));

  const summaryCards = [
    { label: "Total expenses", value: totals ? formatCurrency(totals.totalAmount) : null },
    { label: "Paid", value: totals ? formatCurrency(totals.totalPaid) : null },
    { label: "Outstanding", value: totals ? formatCurrency(totals.totalDue) : null },
    { label: "Average expense", value: totals ? formatCurrency(totals.averageAmount) : null },
  ];

  return (
    <Card className="shadow-none">
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Expense analytics</h2>
          <div className="flex items-center gap-2">
            {comparison && comparison.previousAmount > 0 ? (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-medium",
                  comparison.growthPercent !== null && comparison.growthPercent > 0
                    ? "bg-destructive/10 text-destructive"
                    : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                )}
              >
                {comparison.growthPercent !== null && comparison.growthPercent > 0
                  ? "+"
                  : ""}
                {comparison.growthPercent ?? 0}% vs last month
              </span>
            ) : null}
            <Select
              value={granularity}
              onValueChange={(value) =>
                value && setGranularity(value as ExpenseTrendGranularity)
              }
            >
              <SelectTrigger
                aria-label="Trend granularity"
                className="w-28"
              >
                <SelectValue>{GRANULARITY_LABELS[granularity]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">Daily</SelectItem>
                <SelectItem value="week">Weekly</SelectItem>
                <SelectItem value="month">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {summaryCards.map((card) => (
            <div key={card.label} className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">{card.label}</p>
              {isLoading || !card.value ? (
                <Skeleton className="mt-1 h-6 w-24" />
              ) : (
                <p className="mt-1 text-lg font-semibold tabular-nums">
                  {card.value}
                </p>
              )}
            </div>
          ))}
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {GRANULARITY_LABELS[granularity]} spending
          </h3>
          {isLoading ? (
            <Skeleton className="h-56 w-full" />
          ) : series.length ? (
            <ReportBarChart
              data={series}
              xKey="label"
              height={220}
              bars={[
                { key: "amount", name: "Amount", color: "#0284c7", isCurrency: true },
              ]}
            />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No expenses in this period yet.
            </p>
          )}
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              By category
            </h3>
            {isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : categories.length ? (
              <ReportPieChart
                data={categories.map((c) => ({
                  name: c.categoryName ?? "Uncategorized",
                  value: c.amount,
                }))}
                height={200}
              />
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">—</p>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              By payment method
            </h3>
            {isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : methods.length ? (
              <ul className="space-y-2">
                {methods.map((method) => {
                  const share =
                    totals && totals.totalAmount > 0
                      ? (method.amount / totals.totalAmount) * 100
                      : 0;
                  return (
                    <li key={method.method ?? "none"} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium">
                          {method.method ?? "Unspecified"}
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {formatCurrency(method.amount)} · {method.count}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-sky-600"
                          style={{ width: `${Math.min(100, share)}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">—</p>
            )}
          </div>
        </div>

        {locations.length > 1 ? (
          <div>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Location comparison
            </h3>
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Location</th>
                    <th className="px-3 py-2 text-right font-medium">Expenses</th>
                    <th className="px-3 py-2 text-right font-medium">Paid</th>
                    <th className="px-3 py-2 text-right font-medium">Entries</th>
                  </tr>
                </thead>
                <tbody>
                  {locations.map((location) => (
                    <tr key={location.locationId ?? "none"} className="border-t">
                      <td className="px-3 py-2">
                        {location.locationName ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCurrency(location.amount)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {formatCurrency(location.paid)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {location.count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
