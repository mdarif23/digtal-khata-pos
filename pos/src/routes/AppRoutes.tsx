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
import { RequirePermission } from "@/components/common/PermissionGuard";
import { UsersPage } from "@/features/users/pages/UsersPage";
import { LocationsPage } from "@/features/locations/pages/LocationsPage";
import { StockTransfersPage } from "@/features/stockTransfers/pages/StockTransfersPage";
import { RolesPage } from "@/features/roles/pages/RolesPage";
import { PaymentIntentReturn } from "@/features/pos/pages/PaymentIntentReturn";
import { TaxRatesPage } from "@/features/taxes/pages/TaxRatesPage";
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

const REPORTS_PERMISSIONS = [
  "reports.sales.view",
  "reports.purchase.view",
  "reports.profit.view",
  "reports.expense.view",
  "reports.inventory.view",
  "reports.financial.view",
  "reports.online_profitability.view",
];

const FINANCE_OVERVIEW_PERMISSIONS = ["finance.overview.view", "finance.profit.view"];
const FINANCE_OWNER_PERMISSIONS = ["finance.investment.view", "finance.withdrawal.view"];

const router = createBrowserRouter([
  {
    // Gateway return handler — the provider redirects here with val_id +
    // tran_id; verification happens server-side before anything is recorded.
    path: "/payment/return",
    element: <PaymentIntentReturn />,
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
    ],
  },
  {
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
    path: "/403",
    element: <ForbiddenPage />,
  },
]);

export default function AppRoutes() {
  return <RouterProvider router={router} />;
}
