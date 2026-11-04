import api from "@/api/axios";
import type {
  ReportFilters,
  SalesSummaryReportData,
  PaginatedResponse,
  SalesInvoiceRow,
  ProductSalesRow,
  CustomerSalesRow,
  PaymentMethodRow,
  RefundRow,
  RefundItemRow,
  PurchaseItemRow,
  ProfitReportData,
  ExpenseReportData,
  CustomerReceivablesReportData,
  StockReportData,
  StockMovementRow,
  BatchRow,
  PurchaseReportData,
  SupplierPayablesReportData,
  HourlySalesReportData,
  TaxReconciliationData,
  ShrinkageReportData,
  RegisterCloseData,
} from "../types/report.types";

function buildParams(filters: Partial<ReportFilters>) {
  const params: Record<string, string | number | undefined> = {};
  if (filters.period) params.period = filters.period;
  if (filters.locationId !== undefined) params.locationId = filters.locationId;
  if (filters.dateRange?.startDate) params.startDate = filters.dateRange.startDate;
  if (filters.dateRange?.endDate) params.endDate = filters.dateRange.endDate;
  if (filters.customerId) params.customerId = filters.customerId;
  if (filters.supplierId) params.supplierId = filters.supplierId;
  if (filters.categoryId) params.categoryId = filters.categoryId;
  if (filters.brandId) params.brandId = filters.brandId;
  if (filters.paymentMethod) params.paymentMethod = filters.paymentMethod;
  if (filters.paymentStatus) params.paymentStatus = filters.paymentStatus;
  if (filters.search) params.search = filters.search;
  if (filters.page) params.page = filters.page;
  if (filters.limit) params.limit = filters.limit;
  if (filters.sortBy) params.sortBy = filters.sortBy;
  if (filters.sortDir) params.sortDir = filters.sortDir;
  return params;
}

export interface LocationComparisonRow {
  locationId: number;
  locationName: string;
  locationType: string;
  invoiceCount: number;
  gross: number;
  discount: number;
  refunds: number;
  net: number;
  expenses: number;
}

export interface LocationComparisonData {
  rows: LocationComparisonRow[];
  totals: {
    invoiceCount: number;
    gross: number;
    discounts: number;
    refunds: number;
    net: number;
    expenses: number;
  };
  periodBounds: { start: string; end: string };
}

export interface RegisterSessionRow {
  sessionId: number;
  registerName: string;
  locationName: string;
  userName: string;
  status: string;
  openingCash: number;
  expectedCash: number;
  countedCash: number | null;
  difference: number | null;
  cashSales: number;
  cashIn: number;
  cashOut: number;
  cashRefunds: number;
  safeWithdrawals: number;
  safeDeposits: number;
  adjustmentsIn: number;
  adjustmentsOut: number;
  openedAt: string | null;
  closedAt: string | null;
}

export interface RegisterSessionReportData {
  rows: RegisterSessionRow[];
  totals: {
    sessionCount: number;
    expectedCash: number;
    countedCash: number;
    difference: number;
    cashSales: number;
    cashRefunds: number;
  };
}

export const reportsApi = {
  getChannelPerformance: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: ChannelPerformanceRow[] }>(
      "/reports/analytics/channels",
      { params: buildParams(filters) },
    ),

  getCustomerLifetimeValue: () =>
    api.get<{ success: boolean; data: ClvRow[] }>("/reports/analytics/clv"),

  getCustomerRetention: () =>
    api.get<{ success: boolean; data: RetentionRow[] }>(
      "/reports/analytics/retention",
    ),

  getStaffPerformance: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: StaffPerformanceRow[] }>(
      "/reports/analytics/staff",
      { params: buildParams(filters) },
    ),

  getSalesForecast: () =>
    api.get<{ success: boolean; data: SalesForecastData }>(
      "/reports/analytics/forecast",
    ),

  getInventoryAging: () =>
    api.get<{ success: boolean; data: InventoryAgingData }>(
      "/reports/inventory/aging",
    ),

  getDeadStock: (days = 60) =>
    api.get<{ success: boolean; data: DeadStockRow[] }>(
      "/reports/inventory/dead-stock",
      { params: { days } },
    ),

  getLocationComparison: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: LocationComparisonData }>(
      "/reports/locations/comparison",
      { params: buildParams(filters) },
    ),

  getRegisterSessions: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: RegisterSessionReportData }>(
      "/reports/registers",
      { params: buildParams(filters) },
    ),

  // Sales
  getSalesSummary: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: SalesSummaryReportData }>("/reports/sales/summary", {
      params: buildParams(filters),
    }),

  getHourlySales: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: HourlySalesReportData }>("/reports/sales/hourly", {
      params: buildParams(filters),
    }),

  getSalesByInvoice: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: PaginatedResponse<SalesInvoiceRow> }>("/reports/sales/invoices", {
      params: buildParams(filters),
    }),

  getProductSales: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: PaginatedResponse<ProductSalesRow> }>("/reports/sales/products", {
      params: buildParams(filters),
    }),

  getCustomerSales: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: PaginatedResponse<CustomerSalesRow> }>("/reports/sales/customers", {
      params: buildParams(filters),
    }),

  getPaymentMethods: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: PaymentMethodRow[] }>("/reports/sales/payments", {
      params: buildParams(filters),
    }),

  getSaleRefunds: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: PaginatedResponse<RefundRow> }>("/reports/sales/refunds", {
      params: buildParams(filters),
    }),

  getSaleRefundItems: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: PaginatedResponse<RefundItemRow> }>(
      "/reports/sales/refund-items",
      { params: buildParams(filters) },
    ),

  // Financial
  getProfit: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: ProfitReportData }>("/reports/financial/profit", {
      params: buildParams(filters),
    }),

  getExpenses: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: ExpenseReportData }>("/reports/financial/expenses", {
      params: buildParams(filters),
    }),

  getCustomerReceivables: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: CustomerReceivablesReportData }>("/reports/financial/receivables", {
      params: buildParams(filters),
    }),

  getTaxReconciliation: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: TaxReconciliationData }>("/reports/financial/tax", {
      params: buildParams(filters),
    }),

  getRegisterClose: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: RegisterCloseData }>("/reports/financial/register-close", {
      params: buildParams(filters),
    }),

  // Inventory
  getStock: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: StockReportData }>("/reports/inventory/stock", {
      params: buildParams(filters),
    }),

  getStockMovements: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: PaginatedResponse<StockMovementRow> }>("/reports/inventory/movements", {
      params: buildParams(filters),
    }),

  getBatchExpiry: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: PaginatedResponse<BatchRow> }>("/reports/inventory/batches", {
      params: buildParams(filters),
    }),

  getInventoryShrinkage: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: ShrinkageReportData }>("/reports/inventory/shrinkage", {
      params: buildParams(filters),
    }),

  // Purchases
  getPurchaseItems: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: PaginatedResponse<PurchaseItemRow> }>(
      "/reports/purchases/items",
      { params: buildParams(filters) },
    ),

  getPurchaseSummary: (filters: Partial<ReportFilters> = {}) =>
    api.get<{ success: boolean; data: PurchaseReportData }>("/reports/purchases/summary", {
      params: buildParams(filters),
    }),

  getSupplierPayables: () =>
    api.get<{ success: boolean; data: SupplierPayablesReportData }>("/reports/purchases/payables"),
};

// --- inventory intelligence (Module 2D) -------------------------------------

export interface InventoryAgingRow {
  batchId: number;
  variantId: number;
  productName: string;
  variantOptions?: string | null | undefined;
  variantName?: string | null | undefined;
  sku: string | null;
  batchNumber: string;
  quantityRemaining: number;
  unitCost: number;
  stockValue: number;
  ageDays: number;
  bucket: "0-30" | "31-60" | "61-90" | "90+";
}

export interface InventoryAgingData {
  rows: InventoryAgingRow[];
  buckets: Record<string, { quantity: number; value: number }>;
}

export interface DeadStockRow {
  variantId: number;
  productId: number;
  productName: string;
  variantOptions?: string | null | undefined;
  variantName?: string | null | undefined;
  sku: string | null;
  currentStock: number;
  stockValue: number;
  lastSoldAt: string | null;
  daysSinceLastSale: number | null;
  daysOnShelf: number | null;
}

// --- advanced analytics (Module 15) ------------------------------------------

export interface ChannelPerformanceRow {
  channel: string;
  orders: number;
  revenue: number;
  avgOrderValue: number;
}

export interface ClvRow {
  customerId: number;
  customerName: string;
  phone: string | null;
  orders: number;
  totalSpent: number;
  avgOrderValue: number;
  firstPurchase: string | null;
  lastPurchase: string | null;
}

export interface RetentionRow {
  month: string;
  newCustomers: number;
  returningCustomers: number;
  totalActive: number;
}

export interface StaffPerformanceRow {
  cashierUserId: number;
  cashierName: string;
  orders: number;
  revenue: number;
  avgBasket: number;
}

export interface SalesForecastData {
  history: {
    date: string;
    actualRevenue: number | null;
    projectedRevenue: number;
  }[];
  projection: { next7DaysTotal: number; dailyAverage: number; trendPerDay: number };
  method: string;
}
