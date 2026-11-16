import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  CreditCard,
  Clock3,
  Download,
  LoaderCircle,
  Package,
  Plus,
  Receipt,
  RefreshCw,
  ShoppingBag,
  ShoppingCart,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { Link } from "react-router";
import axios from "../../api/axios.js";
import { useSessionStore } from "@/auth/sessionStore";
import { usePermissions } from "@/hooks/usePermissions";
import { formatCurrency as currency } from "@/lib/format";
import {
  reportsApi,
  type ChannelPerformanceRow,
} from "../../features/reports/api/reports.api.js";
import type { ReportFilters } from "../../features/reports/types/report.types.js";
import type {
  DashboardData,
  LowStockProduct,
  PaymentBreakdown,
  RecentSale,
  SalesActivity,
  SalesOverview,
  StaleStockProduct,
} from "../../types/dashboard.types.js";


import {
  csvCell,
  emptyDashboard,
  formatDate,
  formatTime,
  isDashboardPeriod,
  normalizeDashboard,
  periodOptions,
  staleStockLimits,
  staleStockThresholds,
  type DashboardPeriod,
  type SummaryResponse,
} from "./dashboardNormalizer.js";
import {
  EmptyState,
  MetricCard,
  SectionHeading,
} from "./dashboardPrimitives.js";
import { SalesOverviewChart } from "./SalesOverviewChart.js";


export default function DashboardComponent() {
  const [dashboard, setDashboard] = useState(emptyDashboard);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<DashboardPeriod>("today");
  const [staleDays, setStaleDays] = useState<number>(60);
  const [staleLimit, setStaleLimit] = useState<number>(10);
  // Location scope: All Locations (undefined) or one accessible location.
  // The backend validates the selection against assignments on every call.
  const locations = useSessionStore((state) => state.locations);
  const [locationId, setLocationId] = useState<number | undefined>(undefined);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const requestId = useRef(0);
  const { hasPermission } = usePermissions();

  // Consolidated owner view (Flexible Operating Model Phase 5): revenue by
  // sales channel — in-store POS next to WooCommerce/storefront — reusing the
  // existing channel-performance report (no new calculation).
  const canViewChannelMix = hasPermission("reports.financial.view");
  const [channelMix, setChannelMix] = useState<ChannelPerformanceRow[] | null>(
    null,
  );
  // Out-of-order guard for the channel-mix effect (WP-007).
  const channelMixRequestId = useRef(0);
  const selectedPeriod =
    periodOptions.find((option) => option.value === range) ?? periodOptions[0];
  const periodLabel = selectedPeriod.label;

  const loadDashboard = useCallback(async (background = false) => {
    const activeRequestId = ++requestId.current;
    if (!background) setLoading(true);
    setError(null);
    try {
      const { data } = await axios.get<SummaryResponse>("/dashboard_summary", {
        params: {
          period: range,
          staleDays,
          staleLimit,
          ...(locationId !== undefined ? { locationId } : {}),
        },
      });
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new Error("The dashboard response was not in the expected format.");
      }
      if (requestId.current !== activeRequestId) return;
      setDashboard(normalizeDashboard(data));
      setLastUpdated(new Date());
    } catch (loadError: unknown) {
      if (requestId.current !== activeRequestId) return;
      // Prefer the backend's own message (e.g. "This business has no
      // locations yet…") over axios's generic status-code text.
      const backendMessage =
        (loadError as { response?: { data?: { message?: string } } })
          ?.response?.data?.message ?? null;
      setError(
        backendMessage ??
        (loadError instanceof Error
          ? loadError.message
          : "Unable to load dashboard data."),
      );
    } finally {
      if (requestId.current === activeRequestId) setLoading(false);
    }
  }, [range, staleDays, staleLimit, locationId]);

  useEffect(() => {
    void loadDashboard();
    return () => {
      requestId.current += 1;
    };
  }, [loadDashboard]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        void loadDashboard(true);
      }
    };
    const timerId = window.setInterval(refreshIfVisible, 60_000);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(timerId);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [loadDashboard]);

  // Channel mix follows the same period and location filter as the rest of
  // the dashboard — the report API now shares every dashboard window
  // (WP-006/007: the 60d/90d/365d ranges used to silently fall back to
  // this_month, and the location filter was listed in deps but never sent,
  // so the card contradicted the selected filters). Failures stay silent —
  // this card is an addition, never a blocker for the dashboard itself.
  useEffect(() => {
    if (!canViewChannelMix) {
      setChannelMix(null);
      return;
    }
    const requestId = ++channelMixRequestId;
    const filters: Partial<ReportFilters> = {
      period: range as ReportFilters["period"],
      ...(locationId !== null ? { locationId } : {}),
    };
    void (async () => {
      try {
        const { data } = await reportsApi.getChannelPerformance(filters);
        // Out-of-order guard: only the newest request renders.
        if (requestId !== channelMixRequestId) return;
        setChannelMix(data.data);
      } catch {
        if (requestId === channelMixRequestId) setChannelMix(null);
      }
    })();
  }, [canViewChannelMix, range, locationId]);

  const chartData = useMemo(() => dashboard.salesOverview, [dashboard.salesOverview]);
  const hasData = dashboard.salesOverview.length > 0;
  const lowStockCount =
    dashboard.productsSummary.lowStock + dashboard.productsSummary.stockOut;
  const paymentTotal = dashboard.paymentBreakdown.reduce(
    (total, payment) => total + payment.amount,
    0,
  );

  const exportCsv = () => {
    const rows: (string | number)[][] = [
      ["Metric", "Value"],
      [`Net sales (${periodLabel})`, dashboard.salesSummary.currentNetSales],
      [`Net profit (${periodLabel})`, dashboard.netProfit.currentNetProfit],
      ["Outstanding invoices", dashboard.invoiceDue.currentDue],
      [`Expenses (${periodLabel})`, dashboard.expensesSummary.currentExpenses],
      [`Purchases (${periodLabel})`, dashboard.purchasesSummary.currentPurchases],
      ["Transactions", dashboard.salesActivity.transactionCount],
      ["Average sale", dashboard.salesActivity.averageSale],
      ["Low stock products", dashboard.productsSummary.lowStock],
      ["Out of stock products", dashboard.productsSummary.stockOut],
      [`Slow-moving products (${staleDays}+ days)`, dashboard.staleStockProducts.length],
      ...dashboard.staleStockProducts.map((product) => [
        `${product.variantName || product.productName} (${product.sku ?? "No SKU"})`,
        `${product.quantity} units; ${product.daysSinceLastSale === null ? "never sold" : `${product.daysSinceLastSale} days since last sale`}; stock value ${currency(product.stockValue)}`,
      ] as [string, string]),
      ...dashboard.paymentBreakdown.map((payment) => [
        `Payment method: ${payment.method}`,
        payment.amount,
      ] as [string, number]),
      [],
      ["Invoice", "Customer", "Date", "Total (BDT)", "Payment status"],
      ...dashboard.recentSales.map((sale) => [
        sale.invoiceNumber,
        sale.customerName,
        formatDate(sale.createdAt),
        sale.soldPrice,
        sale.paymentStatus,
      ]),
    ];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `business-dashboard-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-6 p-4 md:p-6">
      <div className="space-y-6">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-success">
              Business overview
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Dashboard
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              A clear view of your sales, cash flow, and inventory.
            </p>
            <p className="mt-1 text-xs text-muted-foreground/80">
              Auto-refreshes every minute
              {lastUpdated
                ? ` · Updated ${new Intl.DateTimeFormat("en-BD", {
                    hour: "numeric",
                    minute: "2-digit",
                    second: "2-digit",
                  }).format(lastUpdated)}`
                : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="dashboard-period" className="sr-only">
              Dashboard date range
            </label>
            {locations.length > 1 ? (
              <>
                <label htmlFor="dashboard-location" className="sr-only">
                  Location scope
                </label>
                <select
                  id="dashboard-location"
                  value={locationId ?? "all"}
                  onChange={(event) =>
                    setLocationId(
                      event.target.value === "all"
                        ? undefined
                        : Number(event.target.value),
                    )
                  }
                  className="h-10 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="all">All Locations</option>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
            <select
              id="dashboard-period"
              value={range}
              onChange={(event) => {
                if (isDashboardPeriod(event.target.value)) {
                  setRange(event.target.value);
                }
              }}
              className="h-10 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {periodOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadDashboard()}
              disabled={loading}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw
                aria-hidden="true"
                className={`size-4 ${loading ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
            <button
              type="button"
              onClick={exportCsv}
              disabled={loading}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Download aria-hidden="true" className="size-4" />
              Export report
            </button>
          </div>
        </header>

        <nav aria-label="Quick actions" className="flex flex-wrap gap-2">
          <Link
            to="/"
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
          >
            <Plus aria-hidden="true" className="size-4" />
            New sale
          </Link>
          <Link
            to="/product/addproduct"
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground transition hover:bg-muted"
          >
            <Package aria-hidden="true" className="size-4" />
            Add product
          </Link>
          <Link
            to="/customer"
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground transition hover:bg-muted"
          >
            <Users aria-hidden="true" className="size-4" />
            Customers
          </Link>
        </nav>

        {error && error.includes("no locations yet") ? (
          <div
            role="status"
            className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-4"
          >
            <p className="text-sm font-medium text-sky-900">
              Create your first location to see your dashboard.
            </p>
            <p className="mt-1 text-sm text-foreground">
              The dashboard tracks sales, stock, and cash per location. Add one
              under Products → Locations, then come back — everything fills in
              automatically.
            </p>
            <a
              href="/locations"
              className="mt-3 inline-flex items-center gap-2 rounded-lg bg-sky-700 px-3 py-2 text-sm font-medium text-white hover:bg-sky-800"
            >
              Go to Locations <ArrowRight aria-hidden="true" className="size-4" />
            </a>
          </div>
        ) : error ? (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-sm text-destructive">
              Dashboard data could not be refreshed. {error}
            </p>
            <button
              type="button"
              onClick={() => void loadDashboard()}
              className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-destructive hover:text-destructive/80"
            >
              Try again <ArrowRight aria-hidden="true" className="size-4" />
            </button>
          </div>
        ) : null}

        <section
          aria-label={`${periodLabel} financial summary`}
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          <MetricCard
            title="Net sales"
            amount={dashboard.salesSummary.currentNetSales}
            growth={dashboard.salesSummary.salesGrowth}
            comparison={selectedPeriod.comparison}
            detail={periodLabel}
            icon={ShoppingCart}
            accent="bg-success/10 text-success"
          />
          <MetricCard
            title="Net profit"
            amount={dashboard.netProfit.currentNetProfit}
            growth={dashboard.netProfit.profitGrowth}
            comparison={selectedPeriod.comparison}
            detail={periodLabel}
            icon={TrendingUp}
            accent="bg-sky-50 text-sky-700"
          />
          <MetricCard
            title="Outstanding invoices"
            amount={dashboard.invoiceDue.currentDue}
            growth={dashboard.invoiceDue.growth}
            growthIsGood={false}
            comparison="vs previous period"
            detail="Current balance"
            icon={Wallet}
            accent="bg-warning/10 text-warning"
          />
          <MetricCard
            title="Expenses"
            amount={dashboard.expensesSummary.currentExpenses}
            growth={dashboard.expensesSummary.expensesGrowth}
            growthIsGood={false}
            comparison={selectedPeriod.comparison}
            detail={periodLabel}
            icon={ShoppingBag}
            accent="bg-primary/10 text-primary"
          />
        </section>

        <section className="grid gap-5 lg:grid-cols-2">
          <article className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6">
            <SectionHeading
              title="Sales activity"
              description={`A quick read on sales volume · ${periodLabel.toLowerCase()}.`}
            />
            <div className="mt-5 grid grid-cols-2 gap-4">
              <div className="rounded-xl bg-muted/50 p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Receipt aria-hidden="true" className="size-4 text-success" />
                  Transactions
                </div>
                <p className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
                  {dashboard.salesActivity.transactionCount.toLocaleString("en-BD")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground/80">{periodLabel}</p>
              </div>
              <div className="rounded-xl bg-muted/50 p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <ShoppingCart aria-hidden="true" className="size-4 text-sky-700" />
                  Average sale
                </div>
                <p className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
                  {currency(dashboard.salesActivity.averageSale)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground/80">Average invoice total</p>
              </div>
            </div>
          </article>

          <article className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6">
            <SectionHeading
              title="Payment methods"
              description={`Payments recorded · ${periodLabel.toLowerCase()}.`}
            />
            {dashboard.paymentBreakdown.length ? (
              <ul className="mt-5 space-y-4">
                {dashboard.paymentBreakdown.map((payment) => {
                  const share =
                    paymentTotal > 0
                      ? (payment.amount / paymentTotal) * 100
                      : 0;
                  const methodName =
                    payment.method === "bangla_qr"
                      ? "Mobile / QR"
                      : payment.method
                        ? payment.method.charAt(0).toUpperCase() +
                          payment.method.slice(1)
                        : "Other";
                  const MethodIcon =
                    payment.method === "cash"
                      ? Banknote
                      : payment.method === "card"
                        ? CreditCard
                        : Wallet;
                  return (
                    <li key={payment.method}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                          <MethodIcon
                            aria-hidden="true"
                            className="size-4 text-muted-foreground/80"
                          />
                          {methodName}
                          <span className="text-xs font-normal text-muted-foreground/80">
                            {payment.paymentCount.toLocaleString("en-BD")} payments
                          </span>
                        </span>
                        <span className="text-sm font-semibold text-foreground">
                          {currency(payment.amount)}
                        </span>
                      </div>
                      <div
                        role="progressbar"
                        aria-label={`${methodName} payment share`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(share)}
                        className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
                      >
                        <div
                          className="h-full rounded-full bg-success transition-all"
                          style={{ width: `${share}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="mt-5">
                <EmptyState>No payment records for this period yet.</EmptyState>
              </div>
            )}
          </article>
        </section>

        {/* Consolidated owner view: revenue by sales channel (POS alongside
            online channels) — reuses the channel-performance report. */}
        {canViewChannelMix && channelMix && channelMix.length > 0 ? (
          <article className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6">
            <SectionHeading
              title="Channel mix"
              description={`Revenue by sales channel · ${periodLabel.toLowerCase()}.`}
              action={
                <Link
                  to="/reports?tab=analytics-channels"
                  className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  Full report
                  <ArrowRight aria-hidden="true" className="size-3.5" />
                </Link>
              }
            />
            <ul className="mt-5 space-y-4">
              {channelMix.map((channel) => {
                const totalRevenue = channelMix.reduce(
                  (sum, row) => sum + row.revenue,
                  0,
                );
                const share =
                  totalRevenue > 0 ? (channel.revenue / totalRevenue) * 100 : 0;
                const label =
                  channel.channel === "pos"
                    ? "In-store (POS)"
                    : channel.channel === "woocommerce"
                      ? "WooCommerce"
                      : channel.channel === "offline"
                        ? "Offline (LAN)"
                        : "Storefront";
                return (
                  <li key={channel.channel}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-foreground">
                        {label}
                        <span className="ml-2 text-xs font-normal text-muted-foreground/80">
                          {channel.orders.toLocaleString("en-BD")} orders
                        </span>
                      </span>
                      <span className="text-sm font-semibold text-foreground">
                        {currency(channel.revenue)}
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label={`${label} revenue share`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(share)}
                      className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
                    >
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${share}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </article>
        ) : null}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-border bg-card p-5 shadow-xs">
            <p className="text-sm font-medium text-muted-foreground">Purchases</p>
            <p className="mt-2 text-xl font-semibold text-foreground">
              {currency(dashboard.purchasesSummary.currentPurchases)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/80">{periodLabel}</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-5 shadow-xs">
            <p className="text-sm font-medium text-muted-foreground">Sales returns</p>
            <p className="mt-2 text-xl font-semibold text-foreground">
              {currency(dashboard.salesSummary.currentReturn)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/80">{periodLabel}</p>
          </div>
          <Link
            to="/product"
            className="rounded-xl border border-border bg-card p-5 shadow-xs transition hover:border-warning/40 hover:bg-warning/10/30"
          >
            <p className="text-sm font-medium text-muted-foreground">Stock to review</p>
            <p className="mt-2 text-xl font-semibold text-foreground">
              {loading ? "…" : lowStockCount}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                products
              </span>
            </p>
            <p className="mt-1 text-xs text-warning">
              {dashboard.productsSummary.stockOut} out of stock ·{" "}
              {dashboard.productsSummary.lowStock} running low
            </p>
          </Link>
          <div className="rounded-xl border border-border bg-card p-5 shadow-xs">
            <p className="text-sm font-medium text-muted-foreground">Inventory value</p>
            <p className="mt-2 text-xl font-semibold text-foreground">
              {currency(dashboard.productsSummary.totalValuation)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/80">
              {dashboard.productsSummary.totalItems.toLocaleString("en-BD")} units in stock
            </p>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.8fr)]">
          <SalesOverviewChart
            chartData={chartData}
            loading={loading}
            hasData={hasData}
            periodLabel={periodLabel}
            comparison={selectedPeriod.comparison}
          />

          <article className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6">
            <SectionHeading
              title="Inventory attention"
              description="Products that may need a restock."
              action={
                <Link
                  to="/product"
                  aria-label="View all products"
                  className="rounded-lg p-2 text-muted-foreground/80 transition hover:bg-muted hover:text-foreground"
                >
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
              }
            />
            {dashboard.lowStockProducts.length ? (
              <ul className="mt-5 divide-y divide-border">
                {dashboard.lowStockProducts.map((product) => (
                  <li
                    key={product.id}
                    className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {product.variantName || product.productName || "Unnamed product"}
                      </p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {product.sku || "No SKU"}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-warning/10 px-2.5 py-1 text-xs font-semibold text-warning">
                      {product.quantity} left
                    </span>
                  </li>
                ))}
              </ul>
            ) : loading ? (
              <div className="flex min-h-36 items-center justify-center text-sm text-muted-foreground">
                <LoaderCircle aria-hidden="true" className="mr-2 size-4 animate-spin" />
                Checking inventory…
              </div>
            ) : (
              <div className="mt-5">
                <EmptyState>
                  {dashboard.productsSummary.stockOut
                    ? `${dashboard.productsSummary.stockOut} products are out of stock.`
                    : "All stocked products are above their alert levels."}
                </EmptyState>
              </div>
            )}
            {lowStockCount > 0 ? (
              <Link
                to="/product"
                className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-success hover:text-success"
              >
                Review inventory <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            ) : null}
          </article>
        </section>

        <section className="grid gap-5 lg:grid-cols-2">
          <article className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6">
            <SectionHeading
              title="Recent sales"
              description={`Latest completed transactions · ${periodLabel.toLowerCase()}.`}
              action={
                <Link
                  to="/sales"
                  className="text-sm font-semibold text-success hover:text-success"
                >
                  View sales
                </Link>
              }
            />
            {dashboard.recentSales.length ? (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs font-medium uppercase tracking-wide text-muted-foreground/80">
                      <th className="pb-3 pr-4">Invoice</th>
                      <th className="pb-3 pr-4">Customer</th>
                      <th className="pb-3 pr-4">Time</th>
                      <th className="pb-3 pr-4">Payment</th>
                      <th className="pb-3 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {dashboard.recentSales.map((sale) => (
                      <tr key={sale.id}>
                        <td className="whitespace-nowrap py-3 pr-4 font-medium text-success">
                          {sale.invoiceNumber || `#${sale.id}`}
                        </td>
                        <td className="max-w-[160px] truncate py-3 pr-4 text-foreground">
                          {sale.customerName || "Walk-in customer"}
                          <span className="ml-1 text-xs text-muted-foreground/80">
                            · {sale.itemCount} items
                          </span>
                        </td>
                        <td className="whitespace-nowrap py-3 pr-4 text-muted-foreground">
                          <span>{formatTime(sale.createdAt)}</span>
                          <span className="ml-1 text-xs text-muted-foreground/80">
                            {formatDate(sale.createdAt)}
                          </span>
                        </td>
                        <td className="py-3 pr-4">
                          <span
                            className={`rounded-full px-2 py-1 text-xs font-medium capitalize ${
                              sale.paymentStatus === "paid"
                                ? "bg-success/10 text-success"
                                : sale.paymentStatus === "partial"
                                  ? "bg-warning/10 text-warning"
                                  : "bg-destructive/10 text-destructive"
                            }`}
                          >
                            {sale.paymentStatus}
                          </span>
                        </td>
                        <td className="whitespace-nowrap py-3 text-right font-semibold text-foreground">
                          {currency(sale.soldPrice)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mt-5">
                <EmptyState>
                  No completed transactions for {periodLabel.toLowerCase()}.
                </EmptyState>
              </div>
            )}
          </article>

          <article className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6">
            <SectionHeading
              title="Top performers"
              description={`Products leading sales · ${periodLabel.toLowerCase()}.`}
              action={
                <Link
                  to="/product"
                  className="text-sm font-semibold text-success hover:text-success"
                >
                  Products
                </Link>
              }
            />
            {dashboard.topSellingProducts.length ? (
              <ul className="mt-4 divide-y divide-border">
                {dashboard.topSellingProducts.map((product, index) => (
                  <li
                    key={`${product.id}-${index}`}
                    className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold text-muted-foreground">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {product.variantName || product.productName || "Unnamed product"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {product.unitsSold.toLocaleString("en-BD")} units sold
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground/80">
                          Average unit price {currency(product.soldPrice)}
                        </p>
                        <p className="mt-1 text-xs font-medium text-muted-foreground">
                          Gross sales {currency(product.grossSales)}
                        </p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-5">
                <EmptyState>Top sellers will appear after your first sales.</EmptyState>
              </div>
            )}
          </article>
        </section>

        <section className="grid gap-5 lg:grid-cols-3">
          <article className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6">
            <SectionHeading
              title="Most sold categories"
              description={`Units sold · ${periodLabel.toLowerCase()}.`}
            />
            {dashboard.topSoldProductsByCategory.length ? (
              <ul className="mt-4 divide-y divide-border">
                {dashboard.topSoldProductsByCategory.map((category) => (
                  <li
                    key={category.category}
                    className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <span className="truncate text-sm font-medium text-foreground">
                      {category.category}
                    </span>
                    <span className="shrink-0 text-sm font-semibold text-foreground">
                      {category.soldItems.toLocaleString("en-BD")} units
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-4">
                <EmptyState>
                  No category sales for {periodLabel.toLowerCase()}.
                </EmptyState>
              </div>
            )}
          </article>

          <article className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6">
            <SectionHeading
              title="Profit by category"
              description={`Top categories · ${periodLabel.toLowerCase()}.`}
            />
            {dashboard.profitByCategory.length ? (
              <ul className="mt-4 divide-y divide-border">
                {dashboard.profitByCategory.map((category) => (
                  <li
                    key={category.category}
                    className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <span className="truncate text-sm font-medium text-foreground">
                      {category.category}
                    </span>
                    <span className="shrink-0 text-sm font-semibold text-foreground">
                      {currency(category.profit)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-4">
                <EmptyState>No category profit data for this month.</EmptyState>
              </div>
            )}
          </article>

          <article className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6">
            <SectionHeading
              title="Top items by gross"
              description={`Highest grossing items · ${periodLabel.toLowerCase()}.`}
            />
            {dashboard.topItemsByGross.length ? (
              <ul className="mt-4 divide-y divide-border">
                {dashboard.topItemsByGross.map((item, index) => (
                  <li
                    key={item.variantId ?? `${item.productName}-${index}`}
                    className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <span className="truncate text-sm font-medium text-foreground">
                      {item.variantName || item.productName}
                    </span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      {item.currentQuantity ? (
                        <span className="text-xs text-muted-foreground/80">
                          {item.currentQuantity.toLocaleString("en-BD")}
                        </span>
                      ) : null}
                      <span className="text-sm font-semibold text-foreground">
                        {currency(item.currentGross)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-4">
                <EmptyState>No gross sales data for this month.</EmptyState>
              </div>
            )}
          </article>
        </section>

        {lowStockCount > 0 ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <AlertTriangle aria-hidden="true" className="size-4 text-warning" />
            {lowStockCount} product{lowStockCount === 1 ? "" : "s"} need
            {lowStockCount === 1 ? "s" : ""} an inventory check.
          </p>
        ) : null}

        <section>
          <article className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6">
            <SectionHeading
              title="Slow-moving stock"
              description={`In-stock products with no completed sale in ${staleDays}+ days, including products never sold. Showing up to ${staleLimit}.`}
              action={
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <label
                      htmlFor="stale-stock-threshold"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      No sale for
                    </label>
                    <select
                      id="stale-stock-threshold"
                      value={staleDays}
                      onChange={(event) => {
                        const threshold = Number(event.target.value);
                        if (
                          staleStockThresholds.some(
                            (supportedThreshold) =>
                              supportedThreshold === threshold,
                          )
                        ) {
                          setStaleDays(threshold);
                        }
                      }}
                      className="h-9 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {staleStockThresholds.map((days) => (
                        <option key={days} value={days}>
                          {days} days
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <label
                      htmlFor="stale-stock-limit"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Show
                    </label>
                    <select
                      id="stale-stock-limit"
                      value={staleLimit}
                      onChange={(event) => {
                        const limit = Number(event.target.value);
                        if (
                          staleStockLimits.some(
                            (supportedLimit) => supportedLimit === limit,
                          )
                        ) {
                          setStaleLimit(limit);
                        }
                      }}
                      className="h-9 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {staleStockLimits.map((limit) => (
                        <option key={limit} value={limit}>
                          {limit}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              }
            />
            {dashboard.staleStockProducts.length ? (
              <div className="mt-5 overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs font-medium uppercase tracking-wide text-muted-foreground/80">
                      <th className="pb-3 pr-4">Product</th>
                      <th className="pb-3 pr-4">SKU</th>
                      <th className="pb-3 pr-4 text-right">In stock</th>
                      <th className="pb-3 pr-4">Last sold</th>
                      <th className="pb-3 text-right">Stock value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {dashboard.staleStockProducts.map((product) => (
                      <tr key={product.id}>
                        <td className="max-w-[240px] truncate py-3 pr-4 font-medium text-foreground">
                          {product.variantName || product.productName || "Unnamed product"}
                        </td>
                        <td className="whitespace-nowrap py-3 pr-4 text-muted-foreground">
                          {product.sku || "No SKU"}
                        </td>
                        <td className="whitespace-nowrap py-3 pr-4 text-right font-medium text-foreground">
                          {product.quantity.toLocaleString("en-BD")}
                        </td>
                        <td className="whitespace-nowrap py-3 pr-4">
                          {product.lastSoldAt ? (
                            <span className="inline-flex items-center gap-2 text-foreground">
                              <Clock3
                                aria-hidden="true"
                                className="size-3.5 text-warning"
                              />
                              {product.daysSinceLastSale} days ago
                              <span className="text-xs text-muted-foreground/80">
                                ({formatDate(product.lastSoldAt)})
                              </span>
                            </span>
                          ) : (
                            <span className="rounded-full bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive">
                              Never sold
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap py-3 text-right font-semibold text-foreground">
                          {currency(product.stockValue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : loading ? (
              <div className="flex min-h-36 items-center justify-center text-sm text-muted-foreground">
                <LoaderCircle
                  aria-hidden="true"
                  className="mr-2 size-4 animate-spin"
                />
                Checking product sales history…
              </div>
            ) : (
              <div className="mt-5">
                <EmptyState>
                  No in-stock products have been inactive for {staleDays} days
                  or longer.
                </EmptyState>
              </div>
            )}
          </article>
        </section>
      </div>
    </div>
  );
}
