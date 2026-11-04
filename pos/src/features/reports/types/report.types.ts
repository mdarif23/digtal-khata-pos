export type ReportPeriod =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "this_month"
  | "last_month"
  | "this_year"
  | "custom";

export interface DateRange {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

export interface ReportFilters {
  period: ReportPeriod;
  dateRange?: DateRange;
  /** Undefined = all accessible locations; a value filters server-side
   *  after access validation (never trusted blindly). */
  locationId?: number;
  customerId?: number;
  supplierId?: number;
  categoryId?: number;
  brandId?: number;
  paymentMethod?: string;
  paymentStatus?: "paid" | "partial" | "unpaid";
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

// ---------------- Sales ----------------
export interface SalesDailyRow {
  sale_date: string;
  invoice_count: number;
  gross_sales: number;
  total_discount: number;
  total_refunds: number;
  net_sales: number;
  gross_profit: number;
}

export interface SalesSummaryTotals {
  total_invoices: number;
  total_gross_sales: number;
  total_discount: number;
  total_refunds: number;
  total_net_sales: number;
  total_gross_profit: number;
  overall_profit_margin: number;
}

export interface SalesSummaryReportData {
  rows: SalesDailyRow[];
  totals: SalesSummaryTotals;
  periodBounds: { start: string; end: string };
}

export interface SalesInvoiceRow {
  id: number;
  invoiceNumber: string;
  createdAt: string;
  customerName: string;
  customerPhone: string;
  subtotal: number;
  discount: number;
  vat: number;
  finalTotal: number;
  paymentStatus: "paid" | "partial" | "unpaid";
  dueAmount: number;
  status: string;
  itemCount: number;
  refundAmount: number;
}

export interface ProductSalesRow {
  productId: number;
  productName: string;
  /** Rows are per variant since the variant-aware API. */
  variantId?: number | undefined;
  variantOptions?: string | null | undefined;
  variantName?: string | null | undefined;
  categoryName: string;
  brandName: string;
  sku: string;
  qtySold: number;
  grossSales: number;
  totalDiscount: number;
  netSales: number;
  totalCost: number;
  grossProfit: number;
  profitMargin: number;
}

export interface CustomerSalesRow {
  customerId: number;
  customerName: string;
  phone: string;
  invoiceCount: number;
  totalSales: number;
  outstandingDue: number;
  totalDiscount: number;
}

export interface PaymentMethodRow {
  paymentMethod: string;
  paymentCount: number;
  totalAmount: number;
}

export interface RefundRow {
  id: number;
  createdAt: string;
  invoiceNumber: string;
  customerName: string;
  reason: string;
  status: string;
  refundTotal: number;
}

export interface RefundItemRow {
  id: number;
  refundId: number;
  refundedAt: string;
  invoiceNumber: string;
  customerName: string;
  disposition: string;
  reason: string | null;
  productId: number;
  productName: string;
  variantId: number;
  variantOptions: string | null;
  variantName: string | null;
  sku: string;
  quantityReturned: number;
  refundPrice: number;
  refundTotal: number;
}

// ---------------- Financial ----------------
export interface ProfitByCategoryRow {
  categoryName: string;
  netSales: number;
  totalCost: number;
  grossProfit: number;
  profitMargin: number;
}

export interface ProfitTotals {
  totalNetSales: number;
  totalCost: number;
  totalGrossProfit: number;
  overallMargin: number;
}

export interface ProfitReportData {
  categories: ProfitByCategoryRow[];
  totals: ProfitTotals;
}

export interface ExpenseRow {
  id: number;
  expenseDate: string;
  title: string;
  categoryName: string;
  amount: number;
  paymentMethod: string;
  referenceNo: string;
  note: string;
}

export interface ExpenseCategoryTotal {
  categoryName: string;
  expenseCount: number;
  totalAmount: number;
}

export interface ExpenseReportData {
  data: ExpenseRow[];
  total: number;
  categoryTotals: ExpenseCategoryTotal[];
  summary: { totalCount: number; grandTotal: number };
  page: number;
  limit: number;
}

export interface CustomerReceivableRow {
  id: number;
  name: string;
  phone: string;
  address: string;
  invoiceCount: number;
  totalInvoiced: number;
  outstandingDue: number;
}

export interface CustomerReceivablesReportData {
  customers: CustomerReceivableRow[];
  totals: { customerCount: number; totalReceivable: number };
}

// ---------------- Inventory ----------------
export interface StockRow {
  productId: number;
  productName: string;
  variantOptions?: string | null | undefined;
  variantName?: string | null | undefined;
  categoryName: string;
  brandName: string;
  variantId: number;
  sku: string;
  barcode: string;
  sellingPrice: number;
  alertQuantity: number;
  currentStock: number;
  reserved: number;
  stockValue: number;
  stockStatus: "in_stock" | "low_stock" | "out_of_stock";
}

export interface StockReportData {
  data: StockRow[];
  total: number;
  valuation: { totalValuation: number; totalUnits: number };
  page: number;
  limit: number;
}

export interface StockMovementRow {
  id: number;
  createdAt: string;
  productName: string;
  variantId?: number | undefined;
  variantOptions?: string | null | undefined;
  variantName?: string | null | undefined;
  sku: string;
  movementType: string;
  quantity: number;
  referenceType: string;
  referenceId: number;
}

export interface BatchRow {
  id: number;
  batchNumber: string;
  productName: string;
  variantId?: number | undefined;
  variantOptions?: string | null | undefined;
  variantName?: string | null | undefined;
  sku: string;
  purchasePrice: number;
  quantityReceived: number;
  quantityRemaining: number;
  manufacturedDate: string | null;
  expiryDate: string | null;
  expiryStatus: "no_expiry" | "expired" | "expiring_soon" | "valid";
}

export interface PurchaseItemRow {
  id: number;
  purchaseId: number;
  purchaseOrderNumber: string;
  purchaseDate: string;
  supplierName: string;
  productId: number;
  productName: string;
  variantId: number;
  variantOptions: string | null;
  variantName: string | null;
  sku: string;
  categoryName: string;
  quantityOrdered: number;
  quantityReceived: number;
  unitCost: number;
  discount: number;
  tax: number;
  lineTotal: number;
}

// ---------------- Purchases ----------------
export interface PurchaseRow {
  id: number;
  purchaseOrderNumber: string;
  purchaseDate: string;
  createdAt: string;
  supplierName: string;
  totalAmount: number;
  paidAmount: number;
  dueAmount: number;
  status: string;
  paymentStatus: string;
}

export interface PurchaseReportData {
  data: PurchaseRow[];
  total: number;
  totals: {
    totalPurchases: number;
    grandTotalAmount: number;
    grandPaidAmount: number;
    grandDueAmount: number;
  };
  page: number;
  limit: number;
}

export interface SupplierPayableRow {
  id: number;
  name: string;
  phone: string;
  email: string;
  purchaseCount: number;
  totalPurchased: number;
  totalPaid: number;
  outstandingDue: number;
}

export interface SupplierPayablesReportData {
  suppliers: SupplierPayableRow[];
  totals: { supplierCount: number; totalPayable: number };
}



// ---------------- Commercial Extensions ----------------

// 0. Online Store Profitability (module three)
export interface ProfitabilitySummary {
  totalOrders: number;
  completedOrders: number;
  cancelledOrders: number;
  refundCount: number;
  grossProductSales: number;
  discounts: number;
  productRefunds: number;
  netProductSales: number;
  cogs: number;
  restockedCost: number;
  grossProfit: number;
  shippingIncome: number;
  courierExpense: number;
  packagingExpense: number;
  gatewayFees: number;
  marketplaceCommission: number;
  netContributionProfit: number;
  grossMarginPercent: number | null;
  contributionMarginPercent: number | null;
}

export interface ProfitabilityTrendPoint {
  date: string;
  netProductSales: number;
  cogs: number;
  grossProfit: number;
  shippingIncome: number;
  netContribution: number;
  orders: number;
}

export interface ProfitabilityProductRow {
  variantId: number;
  productName: string;
  variantOptions?: string | null | undefined;
  variantName?: string | null | undefined;
  sku: string;
  categoryName: string | null;
  quantitySold: number;
  grossRevenue: number;
  refundedRevenue: number;
  netRevenue: number;
  cogs: number;
  restockedCost: number;
  grossProfit: number;
  marginPercent: number | null;
  returnQuantity: number;
}

export interface ProfitabilityChannelRow {
  channel: string;
  orders: number;
  netProductSales: number;
  cogs: number;
  grossProfit: number;
  shippingIncome: number;
  courierExpense: number;
  packagingExpense: number;
  gatewayFees: number;
  marketplaceCommission: number;
  netContribution: number;
}

export interface ProfitabilityExpenseRow {
  categoryId: number | null;
  categoryName: string | null;
  channel: string | null;
  amount: number;
}

export interface ProfitabilityProductsPage {
  rows: ProfitabilityProductRow[];
  total: number;
  page: number;
  pageSize: number;
}

// 1. Hourly Sales
export interface HourlySalesRow {
  hourNum: number;
  hourLabel: string;
  transactionCount: number;
  grossSales: number;
  itemsSold: number;
  averageOrderValue: number;
}

export interface HourlySalesSummary {
  totalTransactions: number;
  totalSales: number;
  totalItemsSold: number;
  overallAOV: number;
}

export interface HourlySalesReportData {
  hours: HourlySalesRow[];
  summary: HourlySalesSummary;
}

// 2. Tax / VAT Reconciliation
export interface SalesTaxSummary {
  taxableInvoices: number;
  taxableSales: number;
  outputVat: number;
  totalGrossSales: number;
}

export interface PurchaseTaxSummary {
  purchaseOrdersCount: number;
  taxablePurchases: number;
  inputVat: number;
  totalPurchases: number;
}

export interface DailyVatRow {
  reportDate: string;
  taxableSales: number;
  outputVat: number;
  taxablePurchases: number;
  inputVat: number;
  netVatPayable: number;
}

export interface TaxReconciliationData {
  salesTax: SalesTaxSummary;
  purchaseTax: PurchaseTaxSummary;
  netTaxLiability: number;
  dailyBreakdown: DailyVatRow[];
}

// 3. Inventory Loss & Shrinkage
export interface ShrinkageRow {
  id: number;
  createdAt: string;
  productName: string;
  variantId?: number | undefined;
  variantOptions?: string | null | undefined;
  variantName?: string | null | undefined;
  sku: string;
  categoryName: string;
  reason: string;
  unitsLost: number;
  unitRetailPrice: number;
  unitCost: number;
  costLoss: number;
  retailLoss: number;
}

export interface ShrinkageReasonSummary {
  reason: string;
  incidentCount: number;
  unitsLost: number;
  costLoss: number;
}

export interface ShrinkageReportData {
  incidents: ShrinkageRow[];
  total: number;
  summary: {
    incidentCount: number;
    totalUnitsLost: number;
    totalCostLoss: number;
    totalRetailLoss: number;
  };
  byReason: ShrinkageReasonSummary[];
  page: number;
  limit: number;
}

// 4. Shift & Register Close (Z-Report)
export interface RegisterSessionZRow {
  sessionId: number;
  registerName: string;
  locationName: string;
  cashierName: string;
  status: string;
  openingCash: number;
  cashSales: number;
  nonCashSales: number;
  cashIn: number;
  cashOut: number;
  cashRefunds: number;
  safeWithdrawals: number;
  safeDeposits: number;
  adjustmentsIn: number;
  adjustmentsOut: number;
  expectedCash: number;
  countedCash: number | null;
  difference: number | null;
  refunds: number;
  openedAt: string | null;
  closedAt: string | null;
}

export interface RegisterCloseData {
  sessions: RegisterSessionZRow[];
  totals: {
    sessionCount: number;
    expectedCash: number;
    countedCash: number;
    difference: number;
    cashSales: number;
    cashRefunds: number;
  };
  cashSales: {
    cashAmount: number;
    cashTxCount: number;
  };
  digitalPayments: {
    method: string;
    amount: number;
    txCount: number;
  }[];
  cashExpenses: {
    cashExpenseTotal: number;
    expenseCount: number;
  };
  salesSummary: {
    totalInvoices: number;
    grossRevenue: number;
    totalDiscount: number;
    totalVat: number;
    creditSalesDue: number;
  };
  refunds: {
    refundCount: number;
    refundTotal: number;
  };
  periodBounds: {
    start: string;
    end: string;
    startDateOnly: string;
    endDateOnly: string;
  };
}
