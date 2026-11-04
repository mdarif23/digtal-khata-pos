export interface SalesOverview {
  month: string;
  sales: number;
  cash: number;
}

export interface LowStockProduct {
  id: number;
  productName: string;
  /** Variant identity from the API — absent on older payloads. */
  variantId?: number | undefined;
  /** Comma-joined option values, e.g. "Small". */
  variantOptions?: string | null | undefined;
  /** Full display label, e.g. "Football (Small)". */
  variantName?: string | null | undefined;
  sku: string;
  status: string;
  quantity: number;
}

export interface StaleStockProduct {
  id: number;
  productName: string;
  variantId?: number | undefined;
  variantOptions?: string | null | undefined;
  variantName?: string | null | undefined;
  sku: string;
  quantity: number;
  lastSoldAt: string | null;
  daysSinceLastSale: number | null;
  stockValue: number;
}

export interface RecentSale {
  id: number;
  invoiceNumber: string;
  createdAt: string;
  customerName: string;
  paymentStatus: "paid" | "partial" | "unpaid";
  itemCount: number;
  soldPrice: number;
}

export interface SalesActivity {
  transactionCount: number;
  averageSale: number;
}

export interface PaymentBreakdown {
  method: string;
  amount: number;
  paymentCount: number;
}

export interface DashboardData {
  salesOverview: SalesOverview[];
  productsSummary: {
    lowStock: number;
    stockOut: number;
    totalItems: number;
    totalValuation: number;
  };
  topItemsByGross: {
    productName: string;
    /** Variant identity — variant-level rows since the variant-aware API. */
    variantId?: number | undefined;
    variantOptions?: string | null | undefined;
    variantName?: string | null | undefined;
    sku?: string | null;
    currentGross: number;
    /** Units sold in the current period (variant-aware API). */
    currentQuantity?: number;
    trend: string;
  }[];
  topSoldProductsByCategory: {
    category: string;
    soldItems: number;
  }[];
  profitByCategory: {
    category: string;
    profit: number;
  }[];
  salesSummary: {
    currentNetSales: number;
    currentReturn: number;
    salesGrowth: number;
    returnGrowth: number;
  };
  salesActivity: SalesActivity;
  paymentBreakdown: PaymentBreakdown[];
  netProfit: {
    currentNetProfit: number;
    profitGrowth: number;
  };
  invoiceDue: {
    currentDue: number;
    growth: number | null;
  };
  expensesSummary: {
    currentExpenses: number;
    expensesGrowth: number | null;
  };
  purchasesSummary: {
    currentPurchases: number;
    purchasesGrowth: number | null;
  };
  returnSummary: {
    currentReturns: number;
    growth: number | null;
  };
  recentSales: RecentSale[];
  lowStockProducts: LowStockProduct[];
  staleStockProducts: StaleStockProduct[];
  topSellingProducts: {
    id: number;
    productName: string;
    /** Variant identity — variant-level rows since the variant-aware API. */
    variantId?: number | undefined;
    variantOptions?: string | null | undefined;
    variantName?: string | null | undefined;
    sku?: string | null;
    unitsSold: number;
    soldPrice: number;
    grossSales: number;
  }[];
}
