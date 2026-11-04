import { useMemo, useState } from "react";
import {
  BadgePercent,
  Banknote,
  Boxes,
  Calculator,
  Package2,
  Scale,
  ShoppingBag,
  Truck,
} from "lucide-react";
import { ReportHeader } from "../components/ReportHeader";
import { ReportDateFilter } from "../components/ReportDateFilter";
import { ReportMetricCard } from "../components/ReportMetricCard";
import { PlanUpgradeCard } from "../components/PlanUpgradeCard";
import { ReportTable } from "../components/ReportTable";
import type { ReportColumn } from "../components/ReportTable";
import {
  ReportBarChart,
  ReportPieChart,
  ReportTrendChart,
} from "../components/ReportChart";
import { useReportData } from "../hooks/useReportData";
import { onlineProfitabilityApi } from "../api/onlineProfitability.api";
import type {
  ProfitabilityChannelRow,
  ProfitabilityProductRow,
  ReportFilters,
} from "../types/report.types";
import {
  exportToCsv,
  formatCurrency,
  formatDate,
  getPeriodDateRange,
} from "../utils/reportUtils";

const CHANNEL_LABELS: Record<string, string> = {
  woocommerce: "WooCommerce",
  custom_storefront: "Storefront",
};

function resolveRange(filters: ReportFilters): {
  from?: string | undefined;
  to?: string | undefined;
} {
  if (filters.period === "custom") {
    return {
      from: filters.dateRange?.startDate,
      to: filters.dateRange?.endDate,
    };
  }
  const range = getPeriodDateRange(filters.period);
  return { from: range?.startDate, to: range?.endDate };
}

/** Online Store Profitability (module three §8). Every figure comes from the
 * backend's persisted order-time snapshots — never current product prices.
 * Net contribution is explicitly NOT full net business profit: only
 * channel-attributed operating expenses enter the estimate below. */
export function OnlineStoreProfitabilityReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
  });
  const [channel, setChannel] = useState<
    "woocommerce" | "custom_storefront" | ""
  >("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<"profit" | "margin" | "losses">("profit");

  const { from, to } = resolveRange(filters);
  const baseParams = useMemo(
    () => ({
      from,
      to,
      ...(filters.locationId ? { locationId: filters.locationId } : {}),
      ...(channel ? { channel } : {}),
    }),
    [from, to, filters.locationId, channel],
  );

  const summary = useReportData(
    () => onlineProfitabilityApi.getSummary(baseParams),
    [baseParams],
  );
  const trends = useReportData(
    () => onlineProfitabilityApi.getTrends(baseParams),
    [baseParams],
  );
  const channels = useReportData(
    () => onlineProfitabilityApi.getChannels(baseParams),
    [baseParams],
  );
  const expenses = useReportData(
    () => onlineProfitabilityApi.getExpenses(baseParams),
    [baseParams],
  );
  const products = useReportData(
    () =>
      onlineProfitabilityApi.getProducts({
        ...baseParams,
        page,
        pageSize: 10,
        sort,
      }),
    [baseParams, page, sort],
  );

  const s = summary.data;
  const operatingExpenses = expenses.data?.total ?? 0;
  const estimatedOperatingProfit =
    s != null ? s.netContributionProfit - operatingExpenses : null;

  const onExport = () => {
    if (!s) return;
    exportToCsv(
      `online-profitability-${from ?? "all"}-to-${to ?? "now"}`,
      ["Metric", "Amount (BDT)"],
      [
        ["Gross product sales", s.grossProductSales],
        ["Discounts", s.discounts],
        ["Product refunds", -s.productRefunds],
        ["Net product sales", s.netProductSales],
        ["Cost of goods sold", -s.cogs],
        ["Gross profit", s.grossProfit],
        ["Shipping income", s.shippingIncome],
        ["Courier expenses", -s.courierExpense],
        ["Packaging expenses", -s.packagingExpense],
        ["Payment gateway fees", -s.gatewayFees],
        ["Marketplace commission", -s.marketplaceCommission],
        ["Net contribution profit", s.netContributionProfit],
        ["Attributed operating expenses", -operatingExpenses],
        ["Estimated operating profit (not full net profit)", estimatedOperatingProfit ?? 0],
      ],
    );
  };

  const productColumns: ReportColumn<ProfitabilityProductRow>[] = [
    {
      key: "productName",
      header: "Product & Variant",
      render: (row) => (
        <div>
          <p className="font-medium text-slate-800">{row.productName}</p>
          {row.variantOptions ? (
            <p className="text-xs text-slate-500">{row.variantOptions}</p>
          ) : null}
          <p className="text-xs text-slate-400">
            {row.sku}
            {row.categoryName ? ` · ${row.categoryName}` : ""}
          </p>
        </div>
      ),
    },
    {
      key: "quantitySold",
      header: "Qty sold",
      className: "text-center",
      render: (row) => (
        <span>
          {row.quantitySold}
          {row.returnQuantity > 0 ? (
            <span className="ml-1 text-xs text-rose-500">
              ({row.returnQuantity} ret)
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "netRevenue",
      header: "Net revenue",
      className: "text-right",
      render: (row) => formatCurrency(row.netRevenue),
    },
    {
      key: "cogs",
      header: "COGS",
      className: "text-right",
      render: (row) => formatCurrency(row.cogs),
    },
    {
      key: "grossProfit",
      header: "Gross profit",
      className: "text-right font-medium",
      render: (row) => (
        <span className={row.grossProfit < 0 ? "text-rose-600" : "text-emerald-700"}>
          {formatCurrency(row.grossProfit)}
        </span>
      ),
    },
    {
      key: "marginPercent",
      header: "Margin",
      className: "text-right",
      render: (row) =>
        row.marginPercent == null ? "—" : `${row.marginPercent.toFixed(1)}%`,
    },
  ];

  return (
    <div className="space-y-5">
      <ReportHeader
        category="Financial"
        title="Online Store Profitability"
        description="Where your online channels actually make money — product margin, shipping, packaging, gateway fees and commissions"
        onExport={onExport}
        onRefresh={() => {
          summary.refetch();
          trends.refetch();
          channels.refetch();
          expenses.refetch();
          products.refetch();
        }}
        loading={summary.loading}
      />

      <ReportDateFilter
        filters={filters}
        onFiltersChange={setFilters}
        extraFilters={
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
            Channel
            <select
              value={channel}
              onChange={(e) => {
                setChannel(
                  e.target.value as "woocommerce" | "custom_storefront" | "",
                );
                setPage(1);
              }}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">All online channels</option>
              <option value="woocommerce">WooCommerce</option>
              <option value="custom_storefront">Storefront</option>
            </select>
          </label>
        }
      />

      {summary.entitlementError ? (
        <PlanUpgradeCard gate={summary.entitlementError} />
      ) : null}

      {summary.error && !summary.entitlementError ? (
        <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {summary.error}
        </div>
      ) : null}

      {/* Product economics */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <ReportMetricCard
          title="Net product sales"
          value={s?.netProductSales ?? "—"}
          isCurrency
          subtitle={`${s?.completedOrders ?? 0} completed · ${s?.cancelledOrders ?? 0} cancelled`}
          icon={ShoppingBag}
          accent="bg-sky-50 text-sky-600"
        />
        <ReportMetricCard
          title="Cost of goods sold"
          value={s?.cogs ?? "—"}
          isCurrency
          subtitle="Actual consumed batch cost"
          icon={Boxes}
          accent="bg-slate-50 text-slate-600"
        />
        <ReportMetricCard
          title="Gross profit"
          value={s?.grossProfit ?? "—"}
          isCurrency
          subtitle={s?.grossMarginPercent != null ? `${s.grossMarginPercent}% margin` : undefined}
          icon={Scale}
          accent="bg-emerald-50 text-emerald-600"
          valueClassName={s && s.grossProfit < 0 ? "text-rose-600" : undefined}
        />
        <ReportMetricCard
          title="Net contribution profit"
          value={s?.netContributionProfit ?? "—"}
          isCurrency
          subtitle={
            s?.contributionMarginPercent != null
              ? `${s.contributionMarginPercent}% of net sales`
              : undefined
          }
          icon={Calculator}
          accent="bg-violet-50 text-violet-600"
          valueClassName={s && s.netContributionProfit < 0 ? "text-rose-600" : undefined}
        />
      </div>

      {/* Fulfillment cost buckets */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <ReportMetricCard
          title="Shipping income"
          value={s?.shippingIncome ?? "—"}
          isCurrency
          subtitle="Delivery charges collected"
          icon={Truck}
          accent="bg-cyan-50 text-cyan-600"
        />
        <ReportMetricCard
          title="Courier expenses"
          value={s?.courierExpense ?? "—"}
          isCurrency
          subtitle="What couriers charge you"
          icon={Truck}
          accent="bg-amber-50 text-amber-600"
        />
        <ReportMetricCard
          title="Packaging expenses"
          value={s?.packagingExpense ?? "—"}
          isCurrency
          subtitle="Recorded packing costs"
          icon={Package2}
          accent="bg-orange-50 text-orange-600"
        />
        <ReportMetricCard
          title="Gateway fees + commission"
          value={
            s ? formatCurrency(s.gatewayFees + s.marketplaceCommission) : "—"
          }
          subtitle={
            s
              ? `${formatCurrency(s.gatewayFees)} fees · ${formatCurrency(s.marketplaceCommission)} commission`
              : undefined
          }
          icon={BadgePercent}
          accent="bg-rose-50 text-rose-600"
        />
      </div>

      {/* Calculation policy note */}
      <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-500">
        Net product sales = order value − collected VAT − delivery charges −
        refunds. COGS uses the historical cost of the inventory actually
        consumed (FIFO batches), never today's prices. Net contribution adds
        shipping income and subtracts courier, packaging, gateway and
        commission costs. Gateway fees and commissions are as recorded on
        payments. This is a contribution view — it is not your full net
        business profit; only channel-attributed operating expenses (below)
        are included in the estimate.
      </p>

      {/* Trend */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">
          Revenue, gross profit &amp; contribution over time
        </h3>
        <ReportTrendChart
          data={(trends.data ?? []) as unknown as Record<string, unknown>[]}
          xKey="date"
          lines={[
            { key: "netProductSales", name: "Net sales", color: "#0284c7" },
            { key: "grossProfit", name: "Gross profit", color: "#059669" },
            {
              key: "netContribution",
              name: "Net contribution",
              color: "#7c3aed",
            },
          ]}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Channel comparison */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">
            Net contribution by channel
          </h3>
          <ReportBarChart
            data={(channels.data ?? []) as unknown as Record<string, unknown>[]}
            xKey="channel"
            bars={[
              { key: "netContribution", name: "Net contribution", color: "#7c3aed" },
              { key: "grossProfit", name: "Gross profit", color: "#059669" },
            ]}
          />
        </div>

        {/* Expense breakdown */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">
            Attributed operating expenses
          </h3>
          <ReportPieChart
            data={(expenses.data?.rows ?? [])
              .filter((r) => r.amount !== 0)
              .map((r) => ({
                name: r.categoryName ?? "Uncategorized",
                value: r.amount,
              }))}
          />
          {expenses.data && expenses.data.total > 0 ? (
            <p className="mt-2 text-center text-xs text-slate-500">
              Total attributed expenses:{" "}
              <span className="font-medium text-slate-700">
                {formatCurrency(expenses.data.total)}
              </span>
            </p>
          ) : null}
        </div>
      </div>

      {/* Estimated operating profit */}
      {s ? (
        <div className="rounded-xl border border-violet-200 bg-violet-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-violet-900">
                <Banknote className="h-4 w-4" />
                Estimated operating profit
              </h3>
              <p className="text-xs text-violet-700">
                Net contribution {formatCurrency(s.netContributionProfit)} −
                attributed operating expenses{" "}
                {formatCurrency(operatingExpenses)}. Excludes rent, salaries
                and other unattributed costs — not full net business profit.
              </p>
            </div>
            <p
              className={`text-2xl font-semibold ${
                (estimatedOperatingProfit ?? 0) < 0
                  ? "text-rose-600"
                  : "text-violet-900"
              }`}
            >
              {formatCurrency(estimatedOperatingProfit)}
            </p>
          </div>
        </div>
      ) : null}

      {/* Product profitability */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-700">
            Product profitability
          </h3>
          <div className="flex gap-1 text-xs">
            {(
              [
                ["profit", "Top profit"],
                ["margin", "Top margin"],
                ["losses", "Losses first"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setSort(value);
                  setPage(1);
                }}
                className={`rounded-md border px-2 py-1 ${
                  sort === value
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-slate-200 text-slate-500 hover:bg-slate-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <ReportTable
          columns={productColumns}
          data={products.data?.rows ?? []}
          loading={products.loading}
          error={products.error}
          emptyMessage="No online sales in this range."
          keyExtractor={(row) => row.variantId}
          page={products.data?.page}
          limit={products.data?.pageSize}
          total={products.data?.total}
          onPageChange={setPage}
        />
      </div>

      {/* Channel detail table */}
      {channels.data && channels.data.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">
            Channel detail
          </h3>
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2">Channel</th>
                <th className="px-3 py-2 text-center">Orders</th>
                <th className="px-3 py-2 text-right">Net sales</th>
                <th className="px-3 py-2 text-right">COGS</th>
                <th className="px-3 py-2 text-right">Gross profit</th>
                <th className="px-3 py-2 text-right">Shipping</th>
                <th className="px-3 py-2 text-right">Fulfillment costs</th>
                <th className="px-3 py-2 text-right">Net contribution</th>
              </tr>
            </thead>
            <tbody>
              {channels.data.map((row: ProfitabilityChannelRow) => (
                <tr
                  key={row.channel}
                  className="border-b border-slate-100 last:border-0"
                >
                  <td className="px-3 py-2 font-medium text-slate-800">
                    {CHANNEL_LABELS[row.channel] ?? row.channel}
                  </td>
                  <td className="px-3 py-2 text-center">{row.orders}</td>
                  <td className="px-3 py-2 text-right">
                    {formatCurrency(row.netProductSales)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatCurrency(row.cogs)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatCurrency(row.grossProfit)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatCurrency(row.shippingIncome)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatCurrency(
                      row.courierExpense +
                        row.packagingExpense +
                        row.gatewayFees +
                        row.marketplaceCommission,
                    )}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-medium ${
                      row.netContribution < 0
                        ? "text-rose-600"
                        : "text-emerald-700"
                    }`}
                  >
                    {formatCurrency(row.netContribution)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="text-xs text-slate-400">
        Range: {from ? formatDate(from) : "beginning"} –{" "}
        {to ? formatDate(to) : "today"}.
      </p>
    </div>
  );
}

export default OnlineStoreProfitabilityReport;
