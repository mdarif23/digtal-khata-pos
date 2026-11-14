import { createBrowserRouter, RouterProvider } from "react-router";
import Pos from "../features/pos/pages/PosPage";
import { CustomersPage } from "../features/Contacts/pages/CustomersPage";
import ProductStockForm from "../features/products/pages/AddProductPage";
import DashboardComponent from "../pages/Dashboard/Dashboard";
import { Sales } from "../features/pos/pages/Sales";
import { Expense } from "../features/Expense/Expense";
import { PurchasesOrder } from "../features/purchases/pages/Purchases";
import { PurchasesList } from "../features/purchases/pages/PurchasesList";
import { ReceiveItems } from "../features/purchases/pages/ReceiveItems";
import { PurchaseViewItems } from "../pages/PurchasesOrder/PurchasesReturn";
import AppLayout from "@/layouts/AppLayout";
import Products from "../features/products/pages/ProductsPage";
import { Categories } from "@/features/products/pages/Categories";
import { Brands } from "@/features/products/pages/Brands";
import { Units } from "@/features/products/pages/Units";
import { Suppliers } from "@/features/Contacts/pages/Suppliers";
import { VariantManager } from "@/features/products/pages/Variants";
import { StockAdjustment } from "@/features/products/pages/StockAdjustment";
import { DueManagementPage } from "@/features/due-management/DueManagementPage";
import ReportsHub from "@/features/reports/pages/ReportsHub";
import ForbiddenPage from "@/pages/ForbiddenPage";
import { RouteErrorBoundary } from "@/components/common/RouteErrorBoundary";
import { RequirePermission } from "@/components/common/PermissionGuard";
import { UsersPage } from "@/features/users/pages/UsersPage";
import { LocationsPage } from "@/features/locations/pages/LocationsPage";
import { StockTransfersPage } from "@/features/stockTransfers/pages/StockTransfersPage";
import { RolesPage } from "@/features/roles/pages/RolesPage";
import { PaymentIntentReturn } from "@/features/pos/pages/PaymentIntentReturn";
import { TaxRatesPage } from "@/features/taxes/pages/TaxRatesPage";
import { ProductPricingPage } from "@/features/pricing/pages/ProductPricingPage";
import { PricingRulesPage } from "@/features/pricing/pages/PricingRulesPage";
import { PricingSettingsPage } from "@/features/pricing/pages/PricingSettingsPage";
import { CustomerGroupsPage } from "@/features/pricing/pages/CustomerGroupsPage";
import { PromotionsPage } from "@/features/pricing/pages/PromotionsPage";
import { PriceHistoryPage } from "@/features/pricing/pages/PriceHistoryPage";
import { PriceProposalsPage } from "@/features/pricing/pages/PriceProposalsPage";
import { BulkUpdatePage } from "@/features/pricing/pages/BulkUpdatePage";
import { PricingReportsPage } from "@/features/pricing/pages/PricingReportsPage";
import ReceiptSettingsPage from "@/features/receipt-settings/pages/ReceiptSettingsPage";
import BackupSettingsPage from "../features/backups/pages/BackupSettingsPage";
import { StockCountPage } from "@/features/products/pages/StockCountPage";
import { ReorderPage } from "@/features/purchases/pages/ReorderPage";
import { PriceMonitoringPage } from "@/features/procurement/pages/PriceMonitoringPage";
import { VariantPriceHistoryPage } from "@/features/procurement/pages/VariantPriceHistoryPage";
import { PriceCheckPage } from "@/features/procurement/pages/PriceCheckPage";
import { SupplierDetailsPage } from "@/features/procurement/pages/SupplierDetailsPage";
import { ReorderDashboardPage } from "@/features/procurement/pages/ReorderDashboardPage";
import { GiftCardsPage } from "@/features/pos/pages/GiftCardsPage";
import { AuditLogsPage } from "@/features/audit/AuditLogsPage";
import { LoyaltySettingsPage } from "@/features/loyalty/LoyaltySettingsPage";
import { QuotationsPage } from "@/features/quotations/QuotationsPage";
import { CommsSettingsPage } from "@/features/comms/CommsSettingsPage";
import { CfdDisplayPage } from "@/features/pos/cfd/CfdDisplayPage";
import { CommissionPage } from "@/features/commission/CommissionPage";
import { TargetsPage } from "@/features/commission/TargetsPage";
import { ProductionPage } from "@/features/products/pages/ProductionPage";
import { CouponsPage } from "@/features/promotions/pages/CouponsPage";
import { AttendancePage } from "@/features/pos/pages/AttendancePage";
import { OnlineOrdersPage } from "@/features/online-orders/pages/OnlineOrdersPage";
import { OnlineOrderDetailsPage } from "@/features/online-orders/pages/OnlineOrderDetailsPage";
import { LandedCostPage } from "@/features/landed-cost/pages/LandedCostPage";
import { ImportWizardPage } from "@/features/products/import/ImportWizardPage";
import { ImportHistoryPage } from "@/features/products/import/ImportHistoryPage";
import { RegisterPage } from "@/features/cashRegisters/RegisterPage";
import { HardwareSettingsPage } from "@/features/hardware/pages/HardwareSettingsPage";
import { BarcodeGeneratorPage } from "@/features/barcodes/pages/BarcodeGeneratorPage";
import { FinanceOverviewPage } from "@/features/finance/pages/FinanceOverviewPage";
import { FinanceReportsPage } from "@/features/finance/pages/FinanceReportsPage";
import { OwnersPage } from "@/features/finance/pages/OwnersPage";
import { ProfitAllocationPage } from "@/features/finance/pages/ProfitAllocationPage";
import { PayrollPage } from "@/features/finance/pages/PayrollPage";
import { CashFlowPage } from "@/features/finance/pages/CashFlowPage";
import { BalanceSheetPage } from "@/features/finance/pages/BalanceSheetPage";
import { GrowthPage } from "@/features/finance/pages/GrowthPage";
import { LoansPage } from "@/features/finance/pages/LoansPage";
import { AssetsPage } from "@/features/finance/pages/AssetsPage";
import { JournalPage } from "@/features/finance/pages/JournalPage";
import { WarrantyOverviewPage } from "@/features/warranty/pages/WarrantyOverviewPage";
import { WarrantyRegistryPage } from "@/features/warranty/pages/WarrantyRegistryPage";
import { WarrantyRegistryDetailPage } from "@/features/warranty/pages/WarrantyRegistryDetailPage";
import { WarrantyClaimsPage } from "@/features/warranty/pages/WarrantyClaimsPage";
import { WarrantyClaimDetailPage } from "@/features/warranty/pages/WarrantyClaimDetailPage";
import { SupplierWarrantiesPage } from "@/features/warranty/pages/SupplierWarrantiesPage";
import { SupplierClaimsPage } from "@/features/warranty/pages/SupplierClaimsPage";
import { SupplierClaimDetailPage } from "@/features/warranty/pages/SupplierClaimDetailPage";

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
    path: "/",
    element: (
      <RequirePermission permission="pos.view">
        <Pos />
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
            <OnlineOrdersPage />
          </RequirePermission>
        ),
      },
      {
        path: "/online-orders/:orderId",
        element: (
          <RequirePermission permission="orders.view">
            <OnlineOrderDetailsPage />
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
            <RegisterPage />
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
            <HardwareSettingsPage />
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

export default function AppRoutes() {
  return <RouterProvider router={router} />;
}
