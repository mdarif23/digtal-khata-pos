import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useGroupProfitability, usePromotionPerformance } from "../hooks/usePricing";

const tk = (n: number) => `৳${n.toFixed(2)}`;

/**
 * Pricing attribution reports (Phase 7): group profitability (from the
 * sales.customer_group_id snapshot) and promotion performance (from
 * sale_items.price_adjustments). History is never rewritten by new prices.
 */
export function PricingReportsPage() {
  const [period, setPeriod] = useState("this_month");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const rangeParams =
    period === "custom" && startDate && endDate
      ? { period, startDate, endDate }
      : { period };

  const groupsQuery = useGroupProfitability(rangeParams);
  const promosQuery = usePromotionPerformance(rangeParams);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Pricing reports</CardTitle>
            <CardDescription>
              Who the discounts go to and what they cost — computed from
              historical sale snapshots.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            >
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="this_month">This month</option>
              <option value="last_month">Last month</option>
              <option value="this_year">This year</option>
              <option value="custom">Custom</option>
            </select>
            {period === "custom" && (
              <>
                <Input
                  type="date"
                  className="w-40"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
                <Input
                  type="date"
                  className="w-40"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setStartDate(startDate);
                    setEndDate(endDate);
                  }}
                >
                  Refresh
                </Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Group profitability */}
          <div className="space-y-2">
            <h3 className="font-semibold">Group profitability</h3>
            {groupsQuery.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (groupsQuery.data?.rows.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">No sales in this period.</p>
            ) : (
              <div className="overflow-hidden rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="p-2 font-medium">Group</th>
                      <th className="p-2 font-medium">Sales</th>
                      <th className="p-2 font-medium">Gross</th>
                      <th className="p-2 font-medium">Group disc.</th>
                      <th className="p-2 font-medium">Promo disc.</th>
                      <th className="p-2 font-medium">Net revenue</th>
                      <th className="p-2 font-medium">Net profit</th>
                      <th className="p-2 font-medium">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(groupsQuery.data?.rows ?? []).map((row) => (
                      <tr key={row.groupId ?? "none"} className="border-t">
                        <td className="p-2 font-medium">{row.groupName}</td>
                        <td className="p-2">{row.salesCount}</td>
                        <td className="p-2 font-mono">{tk(row.grossSales)}</td>
                        <td className="p-2 font-mono text-emerald-700">-{tk(row.groupDiscounts)}</td>
                        <td className="p-2 font-mono text-emerald-700">-{tk(row.promotionDiscounts)}</td>
                        <td className="p-2 font-mono">{tk(row.netRevenue)}</td>
                        <td className={`p-2 font-mono font-semibold ${row.netProfit >= 0 ? "" : "text-destructive"}`}>
                          {tk(row.netProfit)}
                        </td>
                        <td className="p-2">{row.marginPercent}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Promotion performance */}
          <div className="space-y-2">
            <h3 className="font-semibold">Promotion performance</h3>
            {promosQuery.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (promosQuery.data?.rows.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">
                No promotions applied in this period.
              </p>
            ) : (
              <div className="overflow-hidden rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="p-2 font-medium">Promotion</th>
                      <th className="p-2 font-medium">Sales</th>
                      <th className="p-2 font-medium">Total discount given</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(promosQuery.data?.rows ?? []).map((row) => (
                      <tr key={row.promotionId} className="border-t">
                        <td className="p-2 font-medium">{row.promotionName}</td>
                        <td className="p-2">{row.salesCount}</td>
                        <td className="p-2 font-mono text-emerald-700">-{tk(row.totalDiscount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
