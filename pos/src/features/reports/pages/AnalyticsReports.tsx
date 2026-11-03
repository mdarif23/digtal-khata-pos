import { useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
import { Input } from "@/components/ui/input.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { ReportHeader } from "../components/ReportHeader";
import { useReportData } from "../hooks/useReportData";
import { reportsApi } from "../api/reports.api.js";

const tk = (n: number) => `৳${Number(n).toLocaleString()}`;

const CHANNEL_LABELS: Record<string, string> = {
  pos: "In-store (POS)",
  woocommerce: "WooCommerce",
  custom_storefront: "Custom storefront",
};

/** Channel performance (Module 15): revenue and orders per sales channel. */
export function ChannelPerformanceReport() {
  const [filters] = useState({ period: "this_month" } as const);
  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getChannelPerformance(filters),
    [filters],
  );
  const rows = data ?? [];
  const total = rows.reduce((sum, r) => sum + r.revenue, 0);

  return (
    <div className="space-y-4">
      <ReportHeader
        title="Channel Performance"
        description="Revenue and orders per sales channel — in-store vs online."
        onRefresh={refetch}
        loading={loading}
      />
      {loading && <Skeleton className="h-48 w-full" />}
      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            Could not load the channel report.
          </CardContent>
        </Card>
      )}
      {!loading && !error && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Total {tk(total)}</CardTitle>
            <CardDescription>This period, all channels</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2 font-medium">Channel</th>
                  <th className="p-2 text-right font-medium">Orders</th>
                  <th className="p-2 text-right font-medium">Revenue</th>
                  <th className="p-2 text-right font-medium">Avg order</th>
                  <th className="p-2 text-right font-medium">Share</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.channel} className="border-t">
                    <td className="p-2">
                      {CHANNEL_LABELS[row.channel] ?? row.channel}
                    </td>
                    <td className="p-2 text-right font-mono">{row.orders}</td>
                    <td className="p-2 text-right font-mono">
                      {tk(row.revenue)}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {tk(row.avgOrderValue)}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {total > 0 ? `${Math.round((row.revenue / total) * 100)}%` : "—"}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-4 text-center text-muted-foreground">
                      No sales in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Customer lifetime value (Module 15). */
export function CustomerLtvReport() {
  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getCustomerLifetimeValue(),
    [],
  );
  const rows = data ?? [];

  return (
    <div className="space-y-4">
      <ReportHeader
        title="Customer Lifetime Value"
        description="Total spend, order count and average order per customer — highest value first."
        onRefresh={refetch}
        loading={loading}
      />
      {loading && <Skeleton className="h-48 w-full" />}
      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            Could not load the CLV report.
          </CardContent>
        </Card>
      )}
      {!loading && !error && (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2 font-medium">Customer</th>
                  <th className="p-2 text-right font-medium">Orders</th>
                  <th className="p-2 text-right font-medium">Total spent</th>
                  <th className="p-2 text-right font-medium">Avg order</th>
                  <th className="p-2 font-medium">Last purchase</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.customerId} className="border-t">
                    <td className="p-2">{row.customerName}</td>
                    <td className="p-2 text-right font-mono">{row.orders}</td>
                    <td className="p-2 text-right font-mono">
                      {tk(row.totalSpent)}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {tk(row.avgOrderValue)}
                    </td>
                    <td className="p-2 text-muted-foreground">
                      {row.lastPurchase
                        ? new Date(row.lastPurchase).toLocaleDateString()
                        : "—"}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-4 text-center text-muted-foreground">
                      No customer purchases yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Customer retention (Module 15): new vs returning per month. */
export function CustomerRetentionReport() {
  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getCustomerRetention(),
    [],
  );
  const rows = data ?? [];

  return (
    <div className="space-y-4">
      <ReportHeader
        title="Customer Retention"
        description="New vs returning customers per month — returning growth means the base is sticking."
        onRefresh={refetch}
        loading={loading}
      />
      {loading && <Skeleton className="h-48 w-full" />}
      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            Could not load the retention report.
          </CardContent>
        </Card>
      )}
      {!loading && !error && (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2 font-medium">Month</th>
                  <th className="p-2 text-right font-medium">New</th>
                  <th className="p-2 text-right font-medium">Returning</th>
                  <th className="p-2 text-right font-medium">Total active</th>
                  <th className="p-2 text-right font-medium">Retention</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.month} className="border-t">
                    <td className="p-2 font-mono">{row.month}</td>
                    <td className="p-2 text-right font-mono">
                      {row.newCustomers}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {row.returningCustomers}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {row.totalActive}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {row.totalActive > 0
                        ? `${Math.round((row.returningCustomers / row.totalActive) * 100)}%`
                        : "—"}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-4 text-center text-muted-foreground">
                      No identified-customer sales yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Staff performance (Module 15): revenue per cashier. */
export function StaffPerformanceReport() {
  const fmt = (date: Date) => date.toISOString().slice(0, 10);
  const [filters, setFilters] = useState({
    period: "custom" as const,
    dateRange: {
      startDate: fmt(new Date(Date.now() - 30 * 86_400_000)),
      endDate: fmt(new Date()),
    },
  });
  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getStaffPerformance(filters),
    [filters],
  );
  const rows = data ?? [];

  return (
    <div className="space-y-4">
      <ReportHeader
        title="Staff Performance"
        description="Revenue and baskets per cashier (POS sales with register attribution)."
        onRefresh={refetch}
        loading={loading}
        actions={
          <div className="flex items-center gap-2 text-sm">
            <Input
              type="date"
              className="h-8 w-36"
              value={filters.dateRange.startDate}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  dateRange: { ...f.dateRange, startDate: e.target.value },
                }))
              }
            />
            <Input
              type="date"
              className="h-8 w-36"
              value={filters.dateRange.endDate}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  dateRange: { ...f.dateRange, endDate: e.target.value },
                }))
              }
            />
          </div>
        }
      />
      {loading && <Skeleton className="h-48 w-full" />}
      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            Could not load the staff report.
          </CardContent>
        </Card>
      )}
      {!loading && !error && (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2 font-medium">Cashier</th>
                  <th className="p-2 text-right font-medium">Orders</th>
                  <th className="p-2 text-right font-medium">Revenue</th>
                  <th className="p-2 text-right font-medium">Avg basket</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.cashierUserId} className="border-t">
                    <td className="p-2">{row.cashierName}</td>
                    <td className="p-2 text-right font-mono">{row.orders}</td>
                    <td className="p-2 text-right font-mono">
                      {tk(row.revenue)}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {tk(row.avgBasket)}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-4 text-center text-muted-foreground">
                      No attributed sales in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Sales forecast (Module 15): least-squares trend projection. */
export function SalesForecastReport() {
  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getSalesForecast(),
    [],
  );
  const history = data?.history ?? [];
  const projection = data?.projection;

  const recent = useMemo(() => history.slice(-30), [history]);

  return (
    <div className="space-y-4">
      <ReportHeader
        title="Sales Forecast"
        description="Least-squares linear trend over the last 90 days of daily revenue, projected 7 days forward."
        onRefresh={refetch}
        loading={loading}
      />
      {loading && <Skeleton className="h-48 w-full" />}
      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            Could not load the forecast.
          </CardContent>
        </Card>
      )}
      {!loading && !error && projection && (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-1">
                <CardDescription className="text-xs">
                  Next 7 days (projected)
                </CardDescription>
                <CardTitle className="text-lg">
                  {tk(projection.next7DaysTotal)}
                </CardTitle>
              </CardHeader>
              <CardContent />
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardDescription className="text-xs">
                  Projected daily average
                </CardDescription>
                <CardTitle className="text-lg">
                  {tk(projection.dailyAverage)}
                </CardTitle>
              </CardHeader>
              <CardContent />
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardDescription className="text-xs">
                  Trend
                </CardDescription>
                <CardTitle className="text-lg">
                  {projection.trendPerDay >= 0 ? "↑" : "↓"}{" "}
                  {tk(Math.abs(projection.trendPerDay))}/day
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Badge variant="outline">Statistical estimate</Badge>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Last 30 days (actual)</CardTitle>
              <CardDescription>{data?.method}</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2 font-medium">Date</th>
                    <th className="p-2 text-right font-medium">Revenue</th>
                    <th className="p-2 text-right font-medium">Projected</th>
                  </tr>
                </thead>
                <tbody>
                  {[...recent].reverse().map((point) => (
                    <tr key={point.date} className="border-t">
                      <td className="p-2 font-mono text-xs">{point.date}</td>
                      <td className="p-2 text-right font-mono">
                        {point.actualRevenue === null
                          ? "—"
                          : tk(point.actualRevenue)}
                      </td>
                      <td className="p-2 text-right font-mono text-muted-foreground">
                        {tk(point.projectedRevenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
