import { LoaderCircle } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartResponsiveContainer } from "@/components/common/ChartResponsiveContainer";
import { formatCurrency as currency } from "@/lib/format";
import { EmptyState, SectionHeading } from "./dashboardPrimitives.js";

/**
 * Sales overview chart card (Phase 6 Feature 2, lifted verbatim from
 * Dashboard.tsx with the period comparison passed as a prop).
 */
export function SalesOverviewChart({
  chartData,
  loading,
  hasData,
  periodLabel,
  comparison,
}: {
  chartData: { month: string; sales: number; cash: number }[];
  loading: boolean;
  hasData: boolean;
  periodLabel: string;
  comparison: string;
}) {
  return (
          <article className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6">
            <SectionHeading
              title="Sales overview"
              description={`${periodLabel} · ${comparison}.`}
            />
            {loading && !hasData ? (
              <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
                <LoaderCircle aria-hidden="true" className="mr-2 size-4 animate-spin" />
                Loading sales overview…
              </div>
            ) : hasData ? (
              <div className="mt-2 h-[280px] w-full">
                <ChartResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#059669" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="#059669" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="cashFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#0ea5e9" stopOpacity={0.16} />
                        <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="#eef2f6" />
                    <XAxis
                      dataKey="month"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "#64748b", fontSize: 12 }}
                      dy={8}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      width={64}
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      tickFormatter={(value: number) =>
                        value >= 1000 ? `${(value / 1000).toFixed(0)}k` : String(value)
                      }
                    />
                    <Tooltip
                      formatter={(value, name) => [
                        currency(Number(value) || 0),
                        name === "cash" ? "Fully paid" : "Sales",
                      ]}
                      contentStyle={{
                        border: "1px solid #e2e8f0",
                        borderRadius: 12,
                        boxShadow: "0 8px 24px rgba(15, 23, 42, 0.08)",
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="sales"
                      name="Sales"
                      stroke="#059669"
                      strokeWidth={2.5}
                      fill="url(#salesFill)"
                      activeDot={{ r: 5, strokeWidth: 0 }}
                    />
                    <Area
                      type="monotone"
                      dataKey="cash"
                      name="Collected"
                      stroke="#0ea5e9"
                      strokeWidth={2}
                      fill="url(#cashFill)"
                      activeDot={{ r: 4, strokeWidth: 0 }}
                    />
                  </AreaChart>
                </ChartResponsiveContainer>
              </div>
            ) : (
              <div className="mt-5">
                <EmptyState>
                  No sales history for {periodLabel.toLowerCase()} yet.
                </EmptyState>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <span className="size-2 rounded-full bg-success" />
                Total sales
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="size-2 rounded-full bg-sky-500" />
                Fully collected
              </span>
            </div>
          </article>
  );
}
