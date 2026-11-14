import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
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
import {
  Area,
  AreaChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartResponsiveContainer } from "@/components/common/ChartResponsiveContainer";
import { Link } from "react-router";
import axios from "../../api/axios.js";
import { useSessionStore } from "@/auth/sessionStore";
import { formatCurrency as currency } from "@/lib/format";
import type {
  DashboardData,
  LowStockProduct,
  PaymentBreakdown,
  RecentSale,
  SalesActivity,
  SalesOverview,
  StaleStockProduct,
} from "../../types/dashboard.types.js";

type SummaryResponse = Record<string, unknown>;

const emptyDashboard: DashboardData = {
  salesOverview: [],
  productsSummary: {
    lowStock: 0,
    stockOut: 0,
    totalItems: 0,
    totalValuation: 0,
  },
  topItemsByGross: [],
  topSoldProductsByCategory: [],
  profitByCategory: [],
  salesSummary: {
    currentNetSales: 0,
    currentReturn: 0,
    salesGrowth: 0,
    returnGrowth: 0,
  },
  salesActivity: { transactionCount: 0, averageSale: 0 },
  paymentBreakdown: [],
  netProfit: { currentNetProfit: 0, profitGrowth: 0 },
  invoiceDue: { currentDue: 0, growth: null },
  expensesSummary: { currentExpenses: 0, expensesGrowth: null },
  purchasesSummary: { currentPurchases: 0, purchasesGrowth: null },
  returnSummary: { currentReturns: 0, growth: null },
  recentSales: [],
  lowStockProducts: [],
  staleStockProducts: [],
  topSellingProducts: [],
};

const periodOptions = [
  { value: "today", label: "Today", comparison: "vs yesterday" },
  { value: "yesterday", label: "Yesterday", comparison: "vs previous day" },
  { value: "7d", label: "Last 7 days", comparison: "vs previous 7 days" },
  { value: "30d", label: "Last 30 days", comparison: "vs previous 30 days" },
  { value: "60d", label: "Last 2 months", comparison: "vs previous 2 months" },
  { value: "90d", label: "Last 3 months", comparison: "vs previous 3 months" },
  { value: "365d", label: "Last 12 months", comparison: "vs previous 12 months" },
] as const;
type DashboardPeriod = (typeof periodOptions)[number]["value"];
const staleStockThresholds = [30, 60, 90, 180] as const;
const staleStockLimits = [10, 20, 30, 50, 100] as const;

function isDashboardPeriod(value: string): value is DashboardPeriod {
  return periodOptions.some((option) => option.value === value);
}

function readValue(record: SummaryResponse, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function readNumber(record: SummaryResponse, ...keys: string[]): number {
  const value = Number(readValue(record, ...keys));
  return Number.isFinite(value) ? value : 0;
}

function readText(record: SummaryResponse, ...keys: string[]): string {
  const value = readValue(record, ...keys);
  return typeof value === "string" ? value : "";
}

function readPaymentStatus(
  record: SummaryResponse,
): RecentSale["paymentStatus"] {
  const status = readText(record, "paymentStatus", "payment_status");
  return status === "paid" || status === "partial" || status === "unpaid"
    ? status
    : "unpaid";
}

function readRows(value: unknown): SummaryResponse[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is SummaryResponse =>
          typeof row === "object" && row !== null,
      )
    : [];
}

function firstRow(record: SummaryResponse, ...keys: string[]): SummaryResponse {
  return readRows(readValue(record, ...keys))[0] ?? {};
}

function normalizeDashboard(response: SummaryResponse): DashboardData {
  const products = firstRow(response, "productsSummary", "products_summary");
  const sales = firstRow(response, "salesSummary", "sales_summary");
  const activity = firstRow(response, "salesActivity", "sales_activity");
  const profit = firstRow(response, "netProfit", "net_profit");
  const due = firstRow(response, "invoiceDue", "invoice_due");
  const expenses = firstRow(response, "expensesSummary", "expenses_summary");
  const purchases = firstRow(response, "purchasesSummary", "purchases_summary");
  const returns = firstRow(response, "return_summary", "returnSummary");

  const salesOverview: SalesOverview[] = readRows(
    readValue(response, "salesOverview", "sales_overview"),
  ).map((row) => ({
    month: readText(row, "month"),
    sales: readNumber(row, "sales"),
    cash: readNumber(row, "cash"),
  }));
  const lowStockProducts: LowStockProduct[] = readRows(
    readValue(response, "lowStockSummary", "low_stock_summary"),
  ).map((row) => ({
    id: readNumber(row, "id"),
    productName: readText(row, "productName", "product_name"),
    variantOptions: readText(row, "variantOptions", "variant_options") || null,
    variantName: readText(row, "variantName", "variant_name") || null,
    sku: readText(row, "sku"),
    status: readText(row, "status"),
    quantity: readNumber(row, "quantity"),
  }));
  const staleStockProducts: StaleStockProduct[] = readRows(
    readValue(response, "staleStockSummary", "stale_stock_summary"),
  ).map((row) => ({
    id: readNumber(row, "id"),
    productName: readText(row, "productName", "product_name"),
    variantOptions: readText(row, "variantOptions", "variant_options") || null,
    variantName: readText(row, "variantName", "variant_name") || null,
    sku: readText(row, "sku"),
    quantity: readNumber(row, "quantity"),
    lastSoldAt: readText(row, "lastSoldAt", "last_sold_at") || null,
    daysSinceLastSale:
      readValue(row, "daysSinceLastSale", "days_since_last_sale") === undefined
        ? null
        : readNumber(row, "daysSinceLastSale", "days_since_last_sale"),
    stockValue: readNumber(row, "stockValue", "stock_value"),
  }));
  const recentSales: RecentSale[] = readRows(
    readValue(response, "recentSalesSummary", "recent_sales_summary"),
  ).map((row) => ({
    id: readNumber(row, "id"),
    invoiceNumber: readText(row, "invoiceNumber", "invoice_number"),
    createdAt: readText(row, "createdAt", "created_at"),
    customerName: readText(row, "customerName", "customer_name"),
    paymentStatus: readPaymentStatus(row),
    itemCount: readNumber(row, "itemCount", "item_count"),
    soldPrice: readNumber(row, "soldPrice", "sold_price"),
  }));
  const topItemsByGross = readRows(
    readValue(response, "topItemsByGross", "top_items_by_gross"),
  ).map((row) => ({
    productName: readText(row, "productName", "product_name"),
    variantId: readValue(row, "variantId", "variant_id") === undefined ? undefined : readNumber(row, "variantId", "variant_id"),
    variantOptions: readText(row, "variantOptions", "variant_options") || null,
    variantName: readText(row, "variantName", "variant_name") || null,
    sku: readText(row, "sku") || null,
    currentGross: readNumber(row, "currentMonthGross", "current_month_gross"),
    currentQuantity: readNumber(row, "currentMonthQuantity", "current_month_quantity"),
    trend: readText(row, "trend"),
  }));
  const topSoldProductsByCategory = readRows(
    readValue(
      response,
      "top_sold_products_by_category",
      "topSoldProductsByCategory",
    ),
  ).map((row) => ({
    category: readText(row, "category") || "Uncategorized",
    soldItems: readNumber(row, "soldItemsByCategory", "sold_items_by_category"),
  }));
  const profitByCategory = readRows(
    readValue(response, "profitByCategory", "profit_by_category"),
  ).map((row) => ({
    category: readText(row, "category") || "Uncategorized",
    profit: readNumber(row, "currentMonthProfit", "current_month_profit"),
  }));
  const topSellingProducts = readRows(
    readValue(response, "topSellingProducts", "top_selling_products"),
  ).map((row) => ({
    id: readNumber(row, "id"),
    productName: readText(row, "productName", "product_name"),
    variantId: readValue(row, "variantId", "variant_id") === undefined ? undefined : readNumber(row, "variantId", "variant_id"),
    variantOptions: readText(row, "variantOptions", "variant_options") || null,
    variantName: readText(row, "variantName", "variant_name") || null,
    sku: readText(row, "sku") || null,
    unitsSold: readNumber(row, "topSelling", "top_selling"),
    soldPrice: readNumber(row, "soldPrice", "sold_price"),
    grossSales: readNumber(row, "grossSales", "gross_sales"),
  }));
  const paymentBreakdown: PaymentBreakdown[] = readRows(
    readValue(response, "paymentBreakdown", "payment_breakdown"),
  ).map((row) => ({
    method: readText(row, "method", "payment_method"),
    amount: readNumber(row, "amount"),
    paymentCount: readNumber(row, "paymentCount", "payment_count"),
  }));
  const salesActivity: SalesActivity = {
    transactionCount: readNumber(activity, "transactionCount", "transaction_count"),
    averageSale: readNumber(activity, "averageSale", "average_sale"),
  };

  return {
    salesOverview,
    productsSummary: {
      lowStock: readNumber(products, "lowStock", "low_stock"),
      stockOut: readNumber(products, "stockOut", "stock_out"),
      totalItems: readNumber(products, "totalItems", "total_items"),
      totalValuation: readNumber(
        products,
        "totalValuation",
        "total_valuation",
      ),
    },
    topItemsByGross,
    topSoldProductsByCategory,
    profitByCategory,
    salesSummary: {
      currentNetSales: readNumber(sales, "current_net_sales", "currentNetSales"),
      currentReturn: readNumber(sales, "current_return", "currentReturn"),
      salesGrowth: readNumber(sales, "sales_growth", "salesGrowth"),
      returnGrowth: readNumber(sales, "return_growth", "returnGrowth"),
    },
    salesActivity,
    paymentBreakdown,
    netProfit: {
      currentNetProfit: readNumber(profit, "current_net_profit", "currentNetProfit"),
      profitGrowth: readNumber(profit, "profit_growth", "profitGrowth"),
    },
    invoiceDue: {
      currentDue: readNumber(due, "current_due", "currentDue"),
      growth: readNullableNumber(due, "invoice_due_growth_pct", "invoiceDueGrowthPct"),
    },
    expensesSummary: {
      currentExpenses: readNumber(expenses, "current_expenses", "currentExpenses"),
      expensesGrowth: readNullableNumber(expenses, "expenses_growth", "expensesGrowth"),
    },
    purchasesSummary: {
      currentPurchases: readNumber(purchases, "current_purchases", "currentPurchases"),
      purchasesGrowth: readNullableNumber(purchases, "purchases_growth", "purchasesGrowth"),
    },
    returnSummary: {
      currentReturns: readNumber(returns, "current_returns", "currentReturns"),
      growth: readNullableNumber(returns, "return_growth_pct", "returnGrowthPct"),
    },
    recentSales,
    lowStockProducts,
    staleStockProducts,
    topSellingProducts,
  };
}

function readNullableNumber(
  record: SummaryResponse,
  ...keys: string[]
): number | null {
  const value = readValue(record, ...keys);
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat("en-BD", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(date);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : new Intl.DateTimeFormat("en-BD", {
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
}

function csvCell(value: string | number): string {
  const safeValue = String(value).replace(/^[=+\-@]/, "'$&");
  return `"${safeValue.replace(/"/g, '""')}"`;
}

function MetricCard({
  title,
  amount,
  growth,
  comparison,
  growthIsGood = true,
  detail,
  icon: Icon,
  accent,
}: {
  title: string;
  amount: number;
  growth?: number | null;
  comparison: string;
  growthIsGood?: boolean;
  detail: string;
  icon: typeof Wallet;
  accent: string;
}) {
  const growthUp = growth !== null && growth !== undefined && growth >= 0;
  const growthGood = growthUp === growthIsGood;
  const GrowthIcon = growthUp ? ArrowUpRight : ArrowDownRight;
  return (
    <article className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <p className="mt-3 truncate text-2xl font-semibold tracking-tight text-foreground">
            {currency(amount)}
          </p>
        </div>
        <span className={`rounded-xl p-2.5 ${accent}`}>
          <Icon aria-hidden="true" className="size-5" />
        </span>
      </div>
      <div className="mt-4 flex min-h-5 items-center justify-between gap-2">
        {growth === null || growth === undefined ? (
          <span className="text-xs text-muted-foreground">{detail}</span>
        ) : (
          <>
            <span
              className={`inline-flex items-center gap-1 text-xs font-medium ${
                growthGood ? "text-success" : "text-destructive"
              }`}
            >
              <GrowthIcon aria-hidden="true" className="size-3.5" />
              {Math.abs(growth).toLocaleString("en-BD")}% {comparison}
            </span>
            <span className="truncate text-xs text-muted-foreground/80">{detail}</span>
          </>
        )}
      </div>
    </article>
  );
}

function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <h2 className="font-semibold text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-36 items-center justify-center rounded-xl border border-dashed border-border px-4 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

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
          <article className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6">
            <SectionHeading
              title="Sales overview"
              description={`${periodLabel} · ${selectedPeriod.comparison}.`}
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
