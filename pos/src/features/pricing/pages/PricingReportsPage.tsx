import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { formatCurrency } from "@/lib/format";
import { useGroupProfitability, usePromotionPerformance } from "../hooks/usePricing";

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

  const groupRows = groupsQuery.data?.rows ?? [];
  const promoRows = promosQuery.data?.rows ?? [];

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Pricing reports"
        description="Who the discounts go to and what they cost — computed from historical sale snapshots."
      />
      <Card>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap items-end gap-2">
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              aria-label="Report period"
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

          {/* Group profitability */}
          <div className="space-y-2">
            <h3 className="font-semibold">Group profitability</h3>
            {groupsQuery.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <div className="overflow-hidden rounded-md border">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>Group</TableHead>
                      <TableHead className="text-right">Sales</TableHead>
                      <TableHead className="text-right">Gross</TableHead>
                      <TableHead className="text-right">Group disc.</TableHead>
                      <TableHead className="text-right">Promo disc.</TableHead>
                      <TableHead className="text-right">Net revenue</TableHead>
                      <TableHead className="text-right">Net profit</TableHead>
                      <TableHead className="text-right">Margin</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groupRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8}>
                          <EmptyState
                            title="No sales in this period"
                            description="Group discounts will appear here once sales are recorded."
                          />
                        </TableCell>
                      </TableRow>
                    ) : (
                      groupRows.map((row) => (
                        <TableRow key={row.groupId ?? "none"}>
                          <TableCell className="font-medium">{row.groupName}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.salesCount}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums">{formatCurrency(row.grossSales)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-success">
                            -{formatCurrency(row.groupDiscounts)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-success">
                            -{formatCurrency(row.promotionDiscounts)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">{formatCurrency(row.netRevenue)}</TableCell>
                          <TableCell
                            className={`text-right font-mono font-semibold tabular-nums ${row.netProfit >= 0 ? "" : "text-destructive"}`}
                          >
                            {formatCurrency(row.netProfit)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{row.marginPercent}%</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          {/* Promotion performance */}
          <div className="space-y-2">
            <h3 className="font-semibold">Promotion performance</h3>
            {promosQuery.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <div className="overflow-hidden rounded-md border">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>Promotion</TableHead>
                      <TableHead className="text-right">Sales</TableHead>
                      <TableHead className="text-right">Total discount given</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {promoRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3}>
                          <EmptyState
                            title="No promotions applied in this period"
                            description="Promotion performance appears once promotions are used at checkout."
                          />
                        </TableCell>
                      </TableRow>
                    ) : (
                      promoRows.map((row) => (
                        <TableRow key={row.promotionId}>
                          <TableCell className="font-medium">{row.promotionName}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.salesCount}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-success">
                            -{formatCurrency(row.totalDiscount)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
