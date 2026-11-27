import { lazy, Suspense } from "react";
import { createBrowserRouter, RouterProvider } from "react-router";
import Pos from "../features/pos/pages/PosPage";
const CustomersPage = lazy(() =>
  import("../features/Contacts/pages/CustomersPage").then((m2) => ({ default: m2.CustomersPage })),
);
const ProductStockForm = lazy(() => import("../features/products/pages/AddProductPage"));
const DashboardComponent = lazy(() => import("../pages/Dashboard/Dashboard"));
const Sales = lazy(() =>
  import("../features/pos/pages/Sales").then((m2) => ({ default: m2.Sales })),
);
import { Expense } from "../features/Expense/Expense";
const PurchasesOrder = lazy(() =>
  import("../features/purchases/pages/Purchases").then((m2) => ({ default: m2.PurchasesOrder })),
);
const PurchasesList = lazy(() =>
  import("../features/purchases/pages/PurchasesList").then((m2) => ({ default: m2.PurchasesList })),
);
const ReceiveItems = lazy(() =>
  import("../features/purchases/pages/ReceiveItems").then((m2) => ({ default: m2.ReceiveItems })),
);
const PurchaseViewItems = lazy(() =>
  import("../pages/PurchasesOrder/PurchasesReturn").then((m2) => ({ default: m2.PurchaseViewItems })),
);
import AppLayout from "@/layouts/AppLayout";
const Products = lazy(() => import("../features/products/pages/ProductsPage"));
const Categories = lazy(() =>
  import("@/features/products/pages/Categories").then((m2) => ({ default: m2.Categories })),
);
const Brands = lazy(() =>
  import("@/features/products/pages/Brands").then((m2) => ({ default: m2.Brands })),
);
const Units = lazy(() =>
  import("@/features/products/pages/Units").then((m2) => ({ default: m2.Units })),
);
const Suppliers = lazy(() =>
  import("@/features/Contacts/pages/Suppliers").then((m2) => ({ default: m2.Suppliers })),
);
const VariantManager = lazy(() =>
  import("@/features/products/pages/Variants").then((m2) => ({ default: m2.VariantManager })),
);
const StockAdjustment = lazy(() =>
  import("@/features/products/pages/StockAdjustment").then((m2) => ({ default: m2.StockAdjustment })),
);
import { DueManagementPage } from "@/features/due-management/DueManagementPage";
const ReportsHub = lazy(() => import("@/features/reports/pages/ReportsHub"));
import ForbiddenPage from "@/pages/ForbiddenPage";
import { RouteErrorBoundary } from "@/components/common/RouteErrorBoundary";
import { RequirePermission } from "@/components/common/PermissionGuard";
import { RequireMode } from "@/components/common/ModeGuard";
const BusinessOperationsPage = lazy(() =>
  import("@/features/business-operations/pages/BusinessOperationsPage").then((m2) => ({ default: m2.BusinessOperationsPage })),
);
const UsersPage = lazy(() =>
  import("@/features/users/pages/UsersPage").then((m2) => ({ default: m2.UsersPage })),
);
const LocationsPage = lazy(() =>
  import("@/features/locations/pages/LocationsPage").then((m2) => ({ default: m2.LocationsPage })),
);
const StockTransfersPage = lazy(() =>
  import("@/features/stockTransfers/pages/StockTransfersPage").then((m2) => ({ default: m2.StockTransfersPage })),
);
const RolesPage = lazy(() =>
  import("@/features/roles/pages/RolesPage").then((m2) => ({ default: m2.RolesPage })),
);
import { PaymentIntentReturn } from "@/features/pos/pages/PaymentIntentReturn";
const TaxRatesPage = lazy(() =>
  import("@/features/taxes/pages/TaxRatesPage").then((m2) => ({ default: m2.TaxRatesPage })),
);
const ProductPricingPage = lazy(() =>
  import("@/features/pricing/pages/ProductPricingPage").then((m2) => ({ default: m2.ProductPricingPage })),
);
const PricingRulesPage = lazy(() =>
  import("@/features/pricing/pages/PricingRulesPage").then((m2) => ({ default: m2.PricingRulesPage })),
);
const PricingSettingsPage = lazy(() =>
  import("@/features/pricing/pages/PricingSettingsPage").then((m2) => ({ default: m2.PricingSettingsPage })),
);
const CustomerGroupsPage = lazy(() =>
  import("@/features/pricing/pages/CustomerGroupsPage").then((m2) => ({ default: m2.CustomerGroupsPage })),
);
const PromotionsPage = lazy(() =>
  import("@/features/pricing/pages/PromotionsPage").then((m2) => ({ default: m2.PromotionsPage })),
);
const CampaignsPage = lazy(() =>
  import("@/features/pricing/pages/CampaignsPage").then((m2) => ({ default: m2.CampaignsPage })),
);
const PriceHistoryPage = lazy(() =>
  import("@/features/pricing/pages/PriceHistoryPage").then((m2) => ({ default: m2.PriceHistoryPage })),
);
const PriceProposalsPage = lazy(() =>
  import("@/features/pricing/pages/PriceProposalsPage").then((m2) => ({ default: m2.PriceProposalsPage })),
);
const BulkUpdatePage = lazy(() =>
  import("@/features/pricing/pages/BulkUpdatePage").then((m2) => ({ default: m2.BulkUpdatePage })),
);
const PricingReportsPage = lazy(() =>
  import("@/features/pricing/pages/PricingReportsPage").then((m2) => ({ default: m2.PricingReportsPage })),
);
const ReceiptSettingsPage = lazy(() => import("@/features/receipt-settings/pages/ReceiptSettingsPage"));
const BackupSettingsPage = lazy(() => import("../features/backups/pages/BackupSettingsPage"));
const StockCountPage = lazy(() =>
  import("@/features/products/pages/StockCountPage").then((m2) => ({ default: m2.StockCountPage })),
);
const ReorderPage = lazy(() =>
  import("@/features/purchases/pages/ReorderPage").then((m2) => ({ default: m2.ReorderPage })),
);
const PriceMonitoringPage = lazy(() =>
  import("@/features/procurement/pages/PriceMonitoringPage").then((m2) => ({ default: m2.PriceMonitoringPage })),
);
const VariantPriceHistoryPage = lazy(() =>
  import("@/features/procurement/pages/VariantPriceHistoryPage").then((m2) => ({ default: m2.VariantPriceHistoryPage })),
);
const PriceCheckPage = lazy(() =>
  import("@/features/procurement/pages/PriceCheckPage").then((m2) => ({ default: m2.PriceCheckPage })),
);
const SupplierDetailsPage = lazy(() =>
  import("@/features/procurement/pages/SupplierDetailsPage").then((m2) => ({ default: m2.SupplierDetailsPage })),
);
const ReorderDashboardPage = lazy(() =>
  import("@/features/procurement/pages/ReorderDashboardPage").then((m2) => ({ default: m2.ReorderDashboardPage })),
);
const GiftCardsPage = lazy(() =>
  import("@/features/pos/pages/GiftCardsPage").then((m2) => ({ default: m2.GiftCardsPage })),
);
import { AuditLogsPage } from "@/features/audit/AuditLogsPage";
import { LoyaltySettingsPage } from "@/features/loyalty/LoyaltySettingsPage";
import { QuotationsPage } from "@/features/quotations/QuotationsPage";
import { CommsSettingsPage } from "@/features/comms/CommsSettingsPage";
import { ReceiptSharePage } from "@/features/receipt-share/ReceiptSharePage";
import { CfdDisplayPage } from "@/features/pos/cfd/CfdDisplayPage";
import { CommissionPage } from "@/features/commission/CommissionPage";
import { TargetsPage } from "@/features/commission/TargetsPage";
const ProductionPage = lazy(() =>
  import("@/features/products/pages/ProductionPage").then((m2) => ({ default: m2.ProductionPage })),
);
const CouponsPage = lazy(() =>
  import("@/features/promotions/pages/CouponsPage").then((m2) => ({ default: m2.CouponsPage })),
);
const AttendancePage = lazy(() =>
  import("@/features/pos/pages/AttendancePage").then((m2) => ({ default: m2.AttendancePage })),
);
const OnlineOrdersPage = lazy(() =>
  import("@/features/online-orders/pages/OnlineOrdersPage").then((m2) => ({ default: m2.OnlineOrdersPage })),
);
const OnlineOrderDetailsPage = lazy(() =>
  import("@/features/online-orders/pages/OnlineOrderDetailsPage").then((m2) => ({ default: m2.OnlineOrderDetailsPage })),
);
const LandedCostPage = lazy(() =>
  import("@/features/landed-cost/pages/LandedCostPage").then((m2) => ({ default: m2.LandedCostPage })),
);
import { ImportWizardPage } from "@/features/products/import/ImportWizardPage";
import { ImportHistoryPage } from "@/features/products/import/ImportHistoryPage";
import { RegisterPage } from "@/features/cashRegisters/RegisterPage";
const HardwareSettingsPage = lazy(() =>
  import("@/features/hardware/pages/HardwareSettingsPage").then((m2) => ({ default: m2.HardwareSettingsPage })),
);
const BarcodeGeneratorPage = lazy(() =>
  import("@/features/barcodes/pages/BarcodeGeneratorPage").then((m2) => ({ default: m2.BarcodeGeneratorPage })),
);
const FinanceOverviewPage = lazy(() =>
  import("@/features/finance/pages/FinanceOverviewPage").then((m2) => ({ default: m2.FinanceOverviewPage })),
);
const FinanceReportsPage = lazy(() =>
  import("@/features/finance/pages/FinanceReportsPage").then((m2) => ({ default: m2.FinanceReportsPage })),
);
const OwnersPage = lazy(() =>
  import("@/features/finance/pages/OwnersPage").then((m2) => ({ default: m2.OwnersPage })),
);
const ProfitAllocationPage = lazy(() =>
  import("@/features/finance/pages/ProfitAllocationPage").then((m2) => ({ default: m2.ProfitAllocationPage })),
);
const PayrollPage = lazy(() =>
  import("@/features/finance/pages/PayrollPage").then((m2) => ({ default: m2.PayrollPage })),
);
const CashFlowPage = lazy(() =>
  import("@/features/finance/pages/CashFlowPage").then((m2) => ({ default: m2.CashFlowPage })),
);
const BalanceSheetPage = lazy(() =>
  import("@/features/finance/pages/BalanceSheetPage").then((m2) => ({ default: m2.BalanceSheetPage })),
);
const GrowthPage = lazy(() =>
  import("@/features/finance/pages/GrowthPage").then((m2) => ({ default: m2.GrowthPage })),
);
const LoansPage = lazy(() =>
  import("@/features/finance/pages/LoansPage").then((m2) => ({ default: m2.LoansPage })),
);
const AssetsPage = lazy(() =>
  import("@/features/finance/pages/AssetsPage").then((m2) => ({ default: m2.AssetsPage })),
);
const JournalPage = lazy(() =>
  import("@/features/finance/pages/JournalPage").then((m2) => ({ default: m2.JournalPage })),
);
const WarrantyOverviewPage = lazy(() =>
  import("@/features/warranty/pages/WarrantyOverviewPage").then((m2) => ({ default: m2.WarrantyOverviewPage })),
);
const WarrantyRegistryPage = lazy(() =>
  import("@/features/warranty/pages/WarrantyRegistryPage").then((m2) => ({ default: m2.WarrantyRegistryPage })),
);
const WarrantyRegistryDetailPage = lazy(() =>
  import("@/features/warranty/pages/WarrantyRegistryDetailPage").then((m2) => ({ default: m2.WarrantyRegistryDetailPage })),
);
const WarrantyClaimsPage = lazy(() =>
  import("@/features/warranty/pages/WarrantyClaimsPage").then((m2) => ({ default: m2.WarrantyClaimsPage })),
);
const WarrantyClaimDetailPage = lazy(() =>
  import("@/features/warranty/pages/WarrantyClaimDetailPage").then((m2) => ({ default: m2.WarrantyClaimDetailPage })),
);
const SupplierWarrantiesPage = lazy(() =>
  import("@/features/warranty/pages/SupplierWarrantiesPage").then((m2) => ({ default: m2.SupplierWarrantiesPage })),
);
const SupplierClaimsPage = lazy(() =>
  import("@/features/warranty/pages/SupplierClaimsPage").then((m2) => ({ default: m2.SupplierClaimsPage })),
);
const SupplierClaimDetailPage = lazy(() =>
  import("@/features/warranty/pages/SupplierClaimDetailPage").then((m2) => ({ default: m2.SupplierClaimDetailPage })),
);

const REPORTS_PERMISSIONS = [
  "reports.sales.view",
  "reports.purchase.view",
  "reports.profit.view",
  "reports.expense.view",
  "reports.inventory.view",
  "reports.financial.view",
  "reports.online_profitability.view",
  "warranty.reports.view",
];

const FINANCE_OVERVIEW_PERMISSIONS = ["finance.overview.view", "finance.profit.view"];
const FINANCE_OWNER_PERMISSIONS = ["finance.investment.view", "finance.withdrawal.view"];

// Operating-model surfaces — must mirror navigation.ts `modes` entries.
const PHYSICAL_MODES = ["physical_only", "omnichannel"] as const;
const ONLINE_MODES = ["online_only", "omnichannel"] as const;

// All application routes. Mounted inside a single pathless wrapper route
// whose errorElement catches navigation errors and component crashes
// (P1-1: a render error used to unmount the whole tree, POS included).
const routes = [
  {
    // Gateway return handler — the provider redirects here with val_id +
    // tran_id; verification happens server-side before anything is recorded.
    path: "/payment/return",
    element: <PaymentIntentReturn />,
  },
  {
    // Customer-facing display (Phase 3): READ-ONLY second screen with its
    // own pairing/token auth — deliberately OUTSIDE the authed layout.
    path: "/cfd",
    element: <CfdDisplayPage />,
  },
  {
    // P3 Phase 4 (N1-10): the public receipt-share page — token in the URL,
    // no account, expiring/revocable. Deliberately OUTSIDE the authed layout.
    path: "/receipt/t/:token",
    element: <ReceiptSharePage />,
  },
  {
    path: "/",
    element: (
      <RequirePermission permission="pos.view">
        <RequireMode modes={[...PHYSICAL_MODES]}>
          <Pos />
        </RequireMode>
      </RequirePermission>
    ),
  },
  {
    element: <AppLayout />,
    children: [
      {
        path: "/due-management",
        element: (
          <RequirePermission
            anyPermission={["customers.view_ledger", "suppliers.view_ledger"]}
          >
            <DueManagementPage />
          </RequirePermission>
        ),
      },
      {
        path: "/reports",
        element: (
          <RequirePermission anyPermission={REPORTS_PERMISSIONS}>
            <ReportsHub />
          </RequirePermission>
        ),
      },
      {
        path: "/product",
        element: (
          <RequirePermission permission="products.view">
            <Products />
          </RequirePermission>
        ),
      },
      {
        path: "/product/stock-adjustment",
        element: (
          <RequirePermission permission="inventory.adjust">
            <StockAdjustment />
          </RequirePermission>
        ),
      },
      {
        path: "/categories",
        element: (
          <RequirePermission permission="products.view">
            <Categories />
          </RequirePermission>
        ),
      },
      {
        path: "/brands",
        element: (
          <RequirePermission permission="products.view">
            <Brands />
          </RequirePermission>
        ),
      },
      {
        path: "/units",
        element: (
          <RequirePermission permission="products.view">
            <Units />
          </RequirePermission>
        ),
      },
      {
        path: "/variants",
        element: (
          <RequirePermission permission="products.manage_variants">
            <VariantManager />
          </RequirePermission>
        ),
      },
      {
        path: "/suppliers",
        element: (
          <RequirePermission permission="suppliers.view">
            <Suppliers />
          </RequirePermission>
        ),
      },
      {
        path: "/dashboard",
        element: (
          <RequirePermission permission="dashboard.view">
            <DashboardComponent />
          </RequirePermission>
        ),
      },
      {
        path: "/sales",
        element: (
          <RequirePermission permission="sales.view">
            <Sales />
          </RequirePermission>
        ),
      },
      {
        path: "/online-orders",
        element: (
          <RequirePermission permission="orders.view">
            <RequireMode modes={[...ONLINE_MODES]}>
              <OnlineOrdersPage />
            </RequireMode>
          </RequirePermission>
        ),
      },
      {
        path: "/online-orders/:orderId",
        element: (
          <RequirePermission permission="orders.view">
            <RequireMode modes={[...ONLINE_MODES]}>
              <OnlineOrderDetailsPage />
            </RequireMode>
          </RequirePermission>
        ),
      },
      {
        path: "/expense",
        element: (
          <RequirePermission permission="expenses.view">
            <Expense />
          </RequirePermission>
        ),
      },
      {
        path: "/finance",
        element: (
          <RequirePermission anyPermission={FINANCE_OVERVIEW_PERMISSIONS}>
            <FinanceOverviewPage />
          </RequirePermission>
        ),
      },
      {
        path: "/finance/reports",
        element: (
          <RequirePermission permission="finance.profit.view">
            <FinanceReportsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/finance/owners",
        element: (
          <RequirePermission anyPermission={FINANCE_OWNER_PERMISSIONS}>
            <OwnersPage />
          </RequirePermission>
        ),
      },
      {
        path: "/finance/profit-allocations",
        element: (
          <RequirePermission permission="finance.profit.view">
            <ProfitAllocationPage />
          </RequirePermission>
        ),
      },
      {
        path: "/payroll",
        element: (
          <RequirePermission permission="payroll.view">
            <PayrollPage />
          </RequirePermission>
        ),
      },
      {
        path: "/finance/cash-flow",
        element: (
          <RequirePermission permission="finance.overview.view">
            <CashFlowPage />
          </RequirePermission>
        ),
      },
      {
        path: "/finance/balance-sheet",
        element: (
          <RequirePermission permission="finance.overview.view">
            <BalanceSheetPage />
          </RequirePermission>
        ),
      },
      {
        path: "/finance/growth",
        element: (
          <RequirePermission permission="finance.profit.view">
            <GrowthPage />
          </RequirePermission>
        ),
      },
      {
        path: "/finance/loans",
        element: (
          <RequirePermission permission="loans.view">
            <LoansPage />
          </RequirePermission>
        ),
      },
      {
        path: "/finance/assets",
        element: (
          <RequirePermission permission="finance.assets.view">
            <AssetsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/finance/journal",
        element: (
          <RequirePermission permission="finance.journal.view">
            <JournalPage />
          </RequirePermission>
        ),
      },
      {
        path: "/purchases",
        element: (
          <RequirePermission permission="purchases.create">
            <PurchasesOrder />
          </RequirePermission>
        ),
      },
      {
        path: "/purchases-list",
        element: (
          <RequirePermission permission="purchases.view">
            <PurchasesList />
          </RequirePermission>
        ),
      },
      {
        path: "/customer",
        element: (
          <RequirePermission permission="customers.view">
            <CustomersPage />
          </RequirePermission>
        ),
      },
      {
        path: "/receive-items/:id",
        element: (
          <RequirePermission permission="purchases.receive">
            <ReceiveItems />
          </RequirePermission>
        ),
      },
      {
        path: "/product/import",
        element: (
          <RequirePermission permission="products.create">
            <ImportWizardPage />
          </RequirePermission>
        ),
      },
      {
        path: "/product/import-history",
        element: (
          <RequirePermission permission="products.view">
            <ImportHistoryPage />
          </RequirePermission>
        ),
      },
      {
        path: "/purchases/landed-cost/:purchaseId",
        element: (
          <RequirePermission permission="landed_cost.view">
            <LandedCostPage />
          </RequirePermission>
        ),
      },
      {
        path: "/purchase-return/:id",
        element: (
          <RequirePermission permission="purchases.return">
            <PurchaseViewItems />
          </RequirePermission>
        ),
      },
      {
        path: "/locations",
        element: (
          <RequirePermission permission="locations.view">
            <LocationsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/transfers",
        element: (
          <RequirePermission permission="inventory.transfer">
            <StockTransfersPage />
          </RequirePermission>
        ),
      },
      {
        path: "/users",
        element: (
          <RequirePermission permission="users.view">
            <UsersPage />
          </RequirePermission>
        ),
      },
      {
        path: "/attendance",
        element: (
          <RequirePermission permission="attendance.view">
            <AttendancePage />
          </RequirePermission>
        ),
      },
      {
        path: "/coupons",
        element: (
          <RequirePermission permission="promotions.view">
            <CouponsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/loyalty-settings",
        element: (
          <RequirePermission permission="loyalty.manage">
            <LoyaltySettingsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/quotations",
        element: (
          <RequirePermission permission="quotations.view">
            <QuotationsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/comms-settings",
        element: (
          <RequirePermission permission="comms.manage">
            <CommsSettingsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/production",
        element: (
          <RequirePermission permission="products.view">
            <ProductionPage />
          </RequirePermission>
        ),
      },
      {
        path: "/commissions",
        element: (
          <RequirePermission permission="commission.view">
            <CommissionPage />
          </RequirePermission>
        ),
      },
      {
        path: "/targets",
        element: (
          <RequirePermission permission="commission.view">
            <TargetsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/audit-logs",
        element: (
          <RequirePermission permission="audit.view">
            <AuditLogsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/gift-cards",
        element: (
          <RequirePermission permission="pos.view">
            <GiftCardsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/reorder",
        element: (
          <RequirePermission permission="purchases.view">
            <ReorderPage />
          </RequirePermission>
        ),
      },
      {
        path: "/procurement/prices",
        element: (
          <RequirePermission permission="purchases.view">
            <PriceMonitoringPage />
          </RequirePermission>
        ),
      },
      {
        path: "/procurement/prices/:variantId",
        element: (
          <RequirePermission permission="purchases.view">
            <VariantPriceHistoryPage />
          </RequirePermission>
        ),
      },
      {
        path: "/procurement/price-check",
        element: (
          <RequirePermission permission="purchases.view">
            <PriceCheckPage />
          </RequirePermission>
        ),
      },
      {
        path: "/procurement/suppliers/:supplierId",
        element: (
          <RequirePermission
            anyPermission={["suppliers.view", "purchases.view"]}
          >
            <SupplierDetailsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/procurement/reorder",
        element: (
          <RequirePermission permission="purchases.view">
            <ReorderDashboardPage />
          </RequirePermission>
        ),
      },
      {
        path: "/stock-counts",
        element: (
          <RequirePermission permission="inventory.adjust">
            <StockCountPage />
          </RequirePermission>
        ),
      },
      {
        path: "/tax-rates",
        element: (
          <RequirePermission permission="taxes.view">
            <TaxRatesPage />
          </RequirePermission>
        ),
      },
      {
        path: "/pricing/products",
        element: (
          <RequirePermission permission="pricing.view">
            <ProductPricingPage />
          </RequirePermission>
        ),
      },
      {
        path: "/pricing/rules",
        element: (
          <RequirePermission permission="pricing.view">
            <PricingRulesPage />
          </RequirePermission>
        ),
      },
      {
        path: "/pricing/settings",
        element: (
          <RequirePermission permission="pricing.view">
            <PricingSettingsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/pricing/customer-groups",
        element: (
          <RequirePermission permission="pricing.view">
            <CustomerGroupsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/pricing/promotions",
        element: (
          <RequirePermission permission="promotions.view">
            <PromotionsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/pricing/campaigns",
        element: (
          <RequirePermission permission="promotions.view">
            <CampaignsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/pricing/history",
        element: (
          <RequirePermission permission="pricing.history.view">
            <PriceHistoryPage />
          </RequirePermission>
        ),
      },
      {
        path: "/pricing/proposals",
        element: (
          <RequirePermission permission="pricing.history.view">
            <PriceProposalsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/pricing/bulk",
        element: (
          <RequirePermission permission="pricing.bulk_update">
            <BulkUpdatePage />
          </RequirePermission>
        ),
      },
      {
        path: "/pricing/reports",
        element: (
          <RequirePermission permission="pricing.view">
            <PricingReportsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/register",
        element: (
          <RequirePermission permission="cash_register.view">
            <RequireMode modes={[...PHYSICAL_MODES]}>
              <RegisterPage />
            </RequireMode>
          </RequirePermission>
        ),
      },
      {
        path: "/settings/business-operations",
        element: (
          <RequirePermission permission="settings.view">
            <BusinessOperationsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/settings/hardware",
        element: (
          <RequirePermission
            anyPermission={[
              "pos_terminal.view",
              "cash_drawer.open",
              "cash_drawer.open_without_sale",
            ]}
          >
            <RequireMode modes={[...PHYSICAL_MODES]}>
              <HardwareSettingsPage />
            </RequireMode>
          </RequirePermission>
        ),
      },
      {
        path: "/barcode-generator",
        element: (
          <RequirePermission permission="products.view">
            <BarcodeGeneratorPage />
          </RequirePermission>
        ),
      },
      {
        path: "/settings/backup",
        element: (
          <RequirePermission permission="backups.view">
            <BackupSettingsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/settings/receipt",
        element: (
          <RequirePermission permission="receipt_settings.view">
            <ReceiptSettingsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/roles",
        element: (
          <RequirePermission permission="roles.view">
            <RolesPage />
          </RequirePermission>
        ),
      },
      {
        path: "/warranty",
        element: (
          <RequirePermission permission="warranty.view">
            <WarrantyOverviewPage />
          </RequirePermission>
        ),
      },
      {
        path: "/warranty/registry",
        element: (
          <RequirePermission permission="warranty.view">
            <WarrantyRegistryPage />
          </RequirePermission>
        ),
      },
      {
        path: "/warranty/registry/:id",
        element: (
          <RequirePermission permission="warranty.view">
            <WarrantyRegistryDetailPage />
          </RequirePermission>
        ),
      },
      {
        path: "/warranty/claims",
        element: (
          <RequirePermission permission="warranty.view">
            <WarrantyClaimsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/warranty/claims/:id",
        element: (
          <RequirePermission permission="warranty.view">
            <WarrantyClaimDetailPage />
          </RequirePermission>
        ),
      },
      {
        path: "/warranty/supplier",
        element: (
          <RequirePermission permission="warranty.supplier.view">
            <SupplierWarrantiesPage />
          </RequirePermission>
        ),
      },
      {
        path: "/warranty/supplier-claims",
        element: (
          <RequirePermission permission="warranty.supplier.view">
            <SupplierClaimsPage />
          </RequirePermission>
        ),
      },
      {
        path: "/warranty/supplier-claims/:id",
        element: (
          <RequirePermission permission="warranty.supplier.view">
            <SupplierClaimDetailPage />
          </RequirePermission>
        ),
      },
      {
        // Add/edit product render inside the app shell (previously they were
        // standalone full-screen pages — the user lost all navigation in the
        // middle of the most complex form in the app).
        path: "/product/addproduct",
        element: (
          <RequirePermission permission="products.create">
            <ProductStockForm />
          </RequirePermission>
        ),
      },
      {
        path: "/product/:id/edit",
        element: (
          <RequirePermission permission="products.edit">
            <ProductStockForm />
          </RequirePermission>
        ),
      },
      {
        // P1-6: catch-all — unknown URLs render the layout with a clear
        // not-found state instead of a blank content area.
        path: "*",
        element: <RouteErrorBoundary />,
      },
    ],
  },
  {
    path: "/403",
    element: <ForbiddenPage />,
  },
];

const router = createBrowserRouter([
  {
    errorElement: <RouteErrorBoundary />,
    children: routes,
  },
]);

/** R3-003: shown while a route chunk loads (no app-shell flicker). */
function RouteSuspenseFallback() {
  return (
    <div
      role="status"
      aria-label="Loading page"
      className="flex h-screen w-full items-center justify-center bg-background"
    >
      <div className="size-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
    </div>
  );
}

export default function AppRoutes() {
  return (
    <Suspense fallback={<RouteSuspenseFallback />}>
      <RouterProvider router={router} />
    </Suspense>
  );
}
