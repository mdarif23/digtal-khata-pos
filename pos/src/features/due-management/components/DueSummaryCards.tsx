import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartResponsiveContainer } from "@/components/common/ChartResponsiveContainer";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarClock,
  HandCoins,
  ReceiptText,
  Truck,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDueSummary, useDueTrend } from "../hooks/useDueManagement";
import { formatMoney } from "../lib/format";

function SummaryCard({
  title,
  description,
  value,
  icon: Icon,
  iconClassName,
  footer,
  loading,
}: {
  title: string;
  description: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
  footer?: string | undefined;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base font-medium">
          {title}
          <Icon className={`h-5 w-5 ${iconClassName ?? ""}`} />
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-28" />
        ) : (
          <p className="text-2xl font-semibold tabular-nums">{formatMoney(value)}</p>
        )}
        {footer && !loading ? (
          <p className="mt-1 text-xs text-muted-foreground">{footer}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function DueSummaryCards() {
  const summaryQuery = useDueSummary();
  const trendQuery = useDueTrend(14);
  const summary = summaryQuery.data;

  const chartData = useMemo(
    () =>
      (trendQuery.data?.points ?? []).map((point) => ({
        ...point,
        label: new Date(`${point.date}T00:00:00`).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
      })),
    [trendQuery.data],
  );

  const hasTrendActivity = chartData.some(
    (point) => point.collected > 0 || point.paidToSuppliers > 0,
  );

  return (
    <div className="space-y-4">
      {/* Receivables and payables are deliberately kept in separate groups;
          never merge them into a single net number. */}
      <div>
        <p className="mb-2 text-sm font-medium text-muted-foreground">
          Receivables — money customers owe you
        </p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <SummaryCard
            title="Total customer dues"
            description="Open receivable balances"
            value={summary?.customerOutstanding ?? 0}
            icon={ArrowUpRight}
            iconClassName="text-emerald-600"
            footer={
              summary
                ? `${summary.customersWithDue} customer${summary.customersWithDue === 1 ? "" : "s"} with dues`
                : undefined
            }
            loading={summaryQuery.isLoading}
          />
          <SummaryCard
            title={`Overdue customer dues`}
            description={`Unpaid for more than ${summary?.overdueDays ?? 30} days`}
            value={summary?.customerOverdue ?? 0}
            icon={CalendarClock}
            iconClassName="text-red-600"
            loading={summaryQuery.isLoading}
          />
          <SummaryCard
            title="Collected today"
            description="All customer payments today"
            value={summary?.amountCollectedToday ?? 0}
            icon={HandCoins}
            iconClassName="text-emerald-600"
            loading={summaryQuery.isLoading}
          />
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-muted-foreground">
          Payables — money you owe suppliers
        </p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <SummaryCard
            title="Total supplier payables"
            description="Open payable balances"
            value={summary?.supplierOutstanding ?? 0}
            icon={ArrowDownLeft}
            iconClassName="text-amber-600"
            footer={
              summary
                ? `${summary.suppliersWithPayable} supplier${summary.suppliersWithPayable === 1 ? "" : "s"} to pay`
                : undefined
            }
            loading={summaryQuery.isLoading}
          />
          <SummaryCard
            title={`Overdue supplier payables`}
            description={`Unpaid for more than ${summary?.overdueDays ?? 30} days`}
            value={summary?.supplierOverdue ?? 0}
            icon={CalendarClock}
            iconClassName="text-orange-600"
            loading={summaryQuery.isLoading}
          />
          <SummaryCard
            title="Paid to suppliers today"
            description="All supplier payments today"
            value={summary?.amountPaidToSuppliersToday ?? 0}
            icon={Truck}
            iconClassName="text-blue-600"
            loading={summaryQuery.isLoading}
          />
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base font-medium">
            <ReceiptText className="h-4 w-4 text-muted-foreground" />
            Collections vs supplier payments
          </CardTitle>
          <CardDescription>
            Last {trendQuery.data?.days ?? 14} days, based on recorded payments
          </CardDescription>
        </CardHeader>
        <CardContent>
          {trendQuery.isLoading ? (
            <Skeleton className="h-56 w-full" />
          ) : !hasTrendActivity ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No payments recorded in this period yet.
            </p>
          ) : (
            <div className="h-56">
              <ChartResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="collectedFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#059669" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#059669" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="paidFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#d97706" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#d97706" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="label" fontSize={11} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis fontSize={11} tickLine={false} axisLine={false} width={64} tickFormatter={(value: number) => `${Math.round(value)}`} />
                  <Tooltip formatter={(value) => formatMoney(Number(value))} />
                  <Legend />
                  <Area
                    type="monotone"
                    dataKey="collected"
                    name="Collected from customers"
                    stroke="#059669"
                    fill="url(#collectedFill)"
                    strokeWidth={2}
                  />
                  <Area
                    type="monotone"
                    dataKey="paidToSuppliers"
                    name="Paid to suppliers"
                    stroke="#d97706"
                    fill="url(#paidFill)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ChartResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
