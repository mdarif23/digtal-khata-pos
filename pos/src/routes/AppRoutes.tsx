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

const REPORTS_PERMISSIONS = [
  "reports.sales.view",
  "reports.purchase.view",
  "reports.profit.view",
  "reports.expense.view",
  "reports.inventory.view",
  "reports.financial.view",
];

const router = createBrowserRouter([
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
        path: "/expense",
        element: (
          <RequirePermission permission="expenses.view">
            <Expense />
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
