import type {
  DashboardData,
  LowStockProduct,
  PaymentBreakdown,
  RecentSale,
  SalesActivity,
  SalesOverview,
  StaleStockProduct,
} from "@/types/dashboard.types.js";

/**
 * Pure dashboard plumbing (Phase 6 Feature 2, extracted verbatim from
 * Dashboard.tsx): response normalizer, period/threshold option consts and
 * the small read/format helpers shared by the page, its CSV export and
 * the extracted sections. No behavior change.
 */

export type SummaryResponse = Record<string, unknown>;

export const emptyDashboard: DashboardData = {
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

export const periodOptions = [
  { value: "today", label: "Today", comparison: "vs yesterday" },
  { value: "yesterday", label: "Yesterday", comparison: "vs previous day" },
  { value: "7d", label: "Last 7 days", comparison: "vs previous 7 days" },
  { value: "30d", label: "Last 30 days", comparison: "vs previous 30 days" },
  { value: "60d", label: "Last 2 months", comparison: "vs previous 2 months" },
  { value: "90d", label: "Last 3 months", comparison: "vs previous 3 months" },
  { value: "365d", label: "Last 12 months", comparison: "vs previous 12 months" },
] as const;
export type DashboardPeriod = (typeof periodOptions)[number]["value"];
export const staleStockThresholds = [30, 60, 90, 180] as const;
export const staleStockLimits = [10, 20, 30, 50, 100] as const;

export function isDashboardPeriod(value: string): value is DashboardPeriod {
  return periodOptions.some((option) => option.value === value);
}

export function readValue(record: SummaryResponse, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

export function readNumber(record: SummaryResponse, ...keys: string[]): number {
  const value = Number(readValue(record, ...keys));
  return Number.isFinite(value) ? value : 0;
}

export function readText(record: SummaryResponse, ...keys: string[]): string {
  const value = readValue(record, ...keys);
  return typeof value === "string" ? value : "";
}

export function readPaymentStatus(
  record: SummaryResponse,
): RecentSale["paymentStatus"] {
  const status = readText(record, "paymentStatus", "payment_status");
  return status === "paid" || status === "partial" || status === "unpaid"
    ? status
    : "unpaid";
}

export function readRows(value: unknown): SummaryResponse[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is SummaryResponse =>
          typeof row === "object" && row !== null,
      )
    : [];
}

export function firstRow(record: SummaryResponse, ...keys: string[]): SummaryResponse {
  return readRows(readValue(record, ...keys))[0] ?? {};
}

export function normalizeDashboard(response: SummaryResponse): DashboardData {
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

export function readNullableNumber(
  record: SummaryResponse,
  ...keys: string[]
): number | null {
  const value = readValue(record, ...keys);
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat("en-BD", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(date);
}

export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : new Intl.DateTimeFormat("en-BD", {
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
}

export function csvCell(value: string | number): string {
  const safeValue = String(value).replace(/^[=+\-@]/, "'$&");
  return `"${safeValue.replace(/"/g, '""')}"`;
}
