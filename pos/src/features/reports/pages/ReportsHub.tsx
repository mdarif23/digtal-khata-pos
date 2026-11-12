import React from "react";
import { useSearchParams } from "react-router";
import {
  AlertCircle,
  AlertOctagon,
  BarChart3,
  Calculator,
  Calendar,
  Clock,
  CreditCard,
  DollarSign,
  FileText,
  GitCompare,
  Landmark,
  Boxes,
  Layers,
  Package,
  PackageOpen,
  Receipt,
  RotateCcw,
  ShieldCheck,
  ShoppingCart,
  TrendingUp,
  Truck,
  Users,
  Wallet,
} from "lucide-react";
import { SalesSummaryReport } from "./SalesSummaryReport";
import { SalesByInvoiceReport } from "./SalesByInvoiceReport";
import { ProductSalesReport } from "./ProductSalesReport";
import { CustomerSalesReport } from "./CustomerSalesReport";
import { PaymentMethodReport } from "./PaymentMethodReport";
import { SaleRefundsReport } from "./SaleRefundsReport";
import { SaleRefundItemsReport } from "./SaleRefundItemsReport";
import { PurchaseItemsReport } from "./PurchaseItemsReport";
import { HourlySalesReport } from "./HourlySalesReport";
import { ProfitReport } from "./ProfitReport";
import { ExpenseReport } from "./ExpenseReport";
import { CustomerReceivablesReport } from "./CustomerReceivablesReport";
import { TaxReconciliationReport } from "./TaxReconciliationReport";
import { RegisterCloseReport } from "./RegisterCloseReport";
import { StockReport } from "./StockReport";
import { StockMovementReport } from "./StockMovementReport";
import { BatchExpiryReport } from "./BatchExpiryReport";
import {
  DeadStockReport,
  InventoryAgingReport,
} from "./InventoryIntelligenceReports";
import {
  ChannelPerformanceReport,
  CustomerLtvReport,
  CustomerRetentionReport,
  SalesForecastReport,
  StaffPerformanceReport,
} from "./AnalyticsReports";
import { InventoryShrinkageReport } from "./InventoryShrinkageReport";
import { PurchaseSummaryReport } from "./PurchaseSummaryReport";
import { SupplierPayablesReport } from "./SupplierPayablesReport";
import { LocationComparisonReport } from "./LocationComparisonReport";
import { RegisterSessionsReport } from "./RegisterSessionsReport";
import { OnlineStoreProfitabilityReport } from "./OnlineStoreProfitabilityReport";
import { WarrantyExpiryReport } from "@/features/warranty/components/reports/WarrantyExpiryReport";
import { WarrantyClaimsReport } from "@/features/warranty/components/reports/WarrantyClaimsReport";

type ReportTabId =
  // Sales
  | "sales-summary"
  | "sales-hourly"
  | "sales-invoices"
  | "sales-products"
  | "sales-customers"
  | "sales-payments"
  | "sales-refunds"
  | "sales-refund-items"
  // Financial
  | "location-comparison"
  | "register-sessions"
  | "profit"
  | "expenses"
  | "receivables"
  | "tax"
  | "register-close"
  // Online (module three)
  | "online-profitability"
  // Advanced analytics (sidebar-linked; also cased in the switch)
  | "analytics-channels"
  | "analytics-clv"
  | "analytics-retention"
  | "analytics-staff"
  | "analytics-forecast"
  | "inventory-aging"
  | "dead-stock"
  // Inventory
  | "stock"
  | "stock-movements"
  | "batch-expiry"
  | "shrinkage"
  // Purchases
  | "purchases-summary"
  | "purchases-items"
  | "supplier-payables"
  // Warranty
  | "warranty-expiry"
  | "warranty-claims";

interface ReportGroup {
  name: string;
  icon: React.ElementType;
  items: {
    id: ReportTabId;
    label: string;
    icon: React.ElementType;
    description: string;
  }[];
}

const REPORT_GROUPS: ReportGroup[] = [
  {
    name: "Sales Reports",
    icon: ShoppingCart,
    items: [
      {
        id: "sales-summary",
        label: "Sales Summary",
        icon: BarChart3,
        description: "Daily revenue, gross & net sales, profit trends",
      },
      {
        id: "sales-hourly",
        label: "Hourly / Peak Hours",
        icon: Clock,
        description: "Transaction velocity by hour and rush hour peaks",
      },
      {
        id: "sales-invoices",
        label: "Sales by Invoice",
        icon: FileText,
        description: "Invoice-level register, payments, and discounts",
      },
      {
        id: "sales-products",
        label: "Product Sales",
        icon: Package,
        description: "Item and variant sales, COGS, and margins",
      },
      {
        id: "sales-customers",
        label: "Customer Sales",
        icon: Users,
        description: "Spending, order count, and dues per customer",
      },
      {
        id: "sales-payments",
        label: "Payment Breakdown",
        icon: CreditCard,
        description: "Cash, Cards, and Bangla QR collection totals",
      },
      {
        id: "sales-refunds",
        label: "Returns & Refunds",
        icon: RotateCcw,
        description: "Customer return records, reasons, and totals",
      },
      {
        id: "sales-refund-items",
        label: "Returned Items",
        icon: PackageOpen,
        description: "Variant-level refunded lines with quantities",
      },
    ],
  },
  {
    name: "Financial Reports",
    icon: DollarSign,
    items: [
      {
        id: "register-close",
        label: "Shift Close (Z-Report)",
        icon: Calculator,
        description: "Drawer balancing, cash over/short, and printable slip",
      },
      {
        id: "register-sessions",
        label: "Register Sessions",
        icon: Wallet,
        description: "Cashier shifts: expected vs counted cash, over/short",
      },
      {
        id: "location-comparison",
        label: "Location Comparison",
        icon: GitCompare,
        description: "Sales, refunds, net and expenses per location",
      },
      {
        id: "profit",
        label: "Gross Profit & Margins",
        icon: TrendingUp,
        description: "Category profitability with historical sale cost",
      },
      {
        id: "expenses",
        label: "Expense Summary",
        icon: Receipt,
        description: "Operating expenses grouped by category",
      },
      {
        id: "receivables",
        label: "Customer Receivables",
        icon: AlertCircle,
        description: "Customer credit register (Bakir Khata) and balances",
      },
      {
        id: "tax",
        label: "Tax / VAT Reconciliation",
        icon: Landmark,
        description: "Output VAT vs Input VAT and net liability",
      },
    ],
  },
  {
    name: "Online Store",
    icon: Truck,
    items: [
      {
        id: "online-profitability",
        label: "Online Store Profitability",
        icon: Calculator,
        description:
          "Product margin, shipping, packaging, gateway fees — net contribution by channel",
      },
    ],
  },
  {
    name: "Inventory Reports",
    icon: Package,
    items: [
      {
        id: "stock",
        label: "Stock & Valuation",
        icon: Layers,
        description: "Available stock, reorder levels, and asset value",
      },
      {
        id: "stock-movements",
        label: "Stock Movements",
        icon: BarChart3,
        description: "Audit trail of receiving, sales, and corrections",
      },
      {
        id: "shrinkage",
        label: "Loss & Shrinkage",
        icon: AlertOctagon,
        description: "Damaged, expired, lost, and discrepancy loss report",
      },
      {
        id: "batch-expiry",
        label: "Batch & Expiry",
        icon: Calendar,
        description: "Lot tracking, remaining units, and expiry status",
      },
    ],
  },
  {
    name: "Purchase Reports",
    icon: Truck,
    items: [
      {
        id: "purchases-summary",
        label: "Purchase Summary",
        icon: ShoppingCart,
        description: "Orders, supplier disbursements, and receiving status",
      },
      {
        id: "purchases-items",
        label: "Purchase Items",
        icon: Boxes,
        description: "Variant-level purchase lines with historical costs",
      },
      {
        id: "supplier-payables",
        label: "Supplier Payables",
        icon: AlertCircle,
        description: "Outstanding balances owed to suppliers",
      },
    ],
  },
  {
    name: "Warranty Reports",
    icon: ShieldCheck,
    items: [
      {
        id: "warranty-expiry",
        label: "Warranty Expiry",
        icon: Calendar,
        description: "Warranties approaching expiry across the registry",
      },
      {
        id: "warranty-claims",
        label: "Warranty Claims",
        icon: AlertOctagon,
        description: "Claim volume, status, and resolution outcomes",
      },
    ],
  },
];

export default function ReportsHub() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab =
    (searchParams.get("tab") as ReportTabId) || "sales-summary";

  const setTab = (tab: ReportTabId) => {
    setSearchParams({ tab });
  };

  const renderActiveReport = () => {
    switch (currentTab) {
      case "sales-summary":
        return <SalesSummaryReport />;
      case "sales-hourly":
        return <HourlySalesReport />;
      case "sales-invoices":
        return <SalesByInvoiceReport />;
      case "sales-products":
        return <ProductSalesReport />;
      case "sales-customers":
        return <CustomerSalesReport />;
      case "sales-payments":
        return <PaymentMethodReport />;
      case "sales-refunds":
        return <SaleRefundsReport />;
      case "sales-refund-items":
        return <SaleRefundItemsReport />;
      case "register-close":
        return <RegisterCloseReport />;
      case "register-sessions":
        return <RegisterSessionsReport />;
      case "location-comparison":
        return <LocationComparisonReport />;
      case "profit":
        return <ProfitReport />;
      case "online-profitability":
        return <OnlineStoreProfitabilityReport />;
      case "expenses":
        return <ExpenseReport />;
      case "receivables":
        return <CustomerReceivablesReport />;
      case "tax":
        return <TaxReconciliationReport />;
      case "stock":
        return <StockReport />;
      case "stock-movements":
        return <StockMovementReport />;
      case "shrinkage":
        return <InventoryShrinkageReport />;
      case "batch-expiry":
        return <BatchExpiryReport />;
      case "analytics-channels":
        return <ChannelPerformanceReport />;
      case "analytics-clv":
        return <CustomerLtvReport />;
      case "analytics-retention":
        return <CustomerRetentionReport />;
      case "analytics-staff":
        return <StaffPerformanceReport />;
      case "analytics-forecast":
        return <SalesForecastReport />;
      case "inventory-aging":
        return <InventoryAgingReport />;
      case "dead-stock":
        return <DeadStockReport />;
      case "purchases-summary":
        return <PurchaseSummaryReport />;
      case "purchases-items":
        return <PurchaseItemsReport />;
      case "supplier-payables":
        return <SupplierPayablesReport />;
      case "warranty-expiry":
        return <WarrantyExpiryReport />;
      case "warranty-claims":
        return <WarrantyClaimsReport />;
      default:
        return <SalesSummaryReport />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-50/70 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        {/* Navigation Selector Bar */}
        <div className="rounded-2xl border border-slate-200/90 bg-white p-3 shadow-xs print:hidden">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 pb-3 mb-3">
            {REPORT_GROUPS.map((group) => {
              const isGroupActive = group.items.some(
                (item) => item.id === currentTab
              );
              const GroupIcon = group.icon;
              return (
                <div key={group.name} className="flex items-center gap-1">
                  <span
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider ${
                      isGroupActive
                        ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                        : "text-slate-500 bg-slate-50"
                    }`}
                  >
                    <GroupIcon className="size-3.5" />
                    {group.name}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Sub-Tabs Grid */}
          <div className="flex flex-wrap gap-1.5">
            {REPORT_GROUPS.flatMap((group) => group.items).map((item) => {
              const isActive = item.id === currentTab;
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-all ${
                    isActive
                      ? "bg-slate-900 text-white shadow-xs font-semibold"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  }`}
                >
                  <Icon className="size-3.5" />
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Active Report Component */}
        <main className="rounded-2xl border border-slate-200/80 bg-white p-5 sm:p-7 shadow-xs">
          {renderActiveReport()}
        </main>
      </div>
    </div>
  );
}
