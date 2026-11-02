import {
  ContactRound,
  CreditCard,
  LayoutDashboard,
  MapPin,
  Package,
  Tags,
  Users,
  BarChart3,
  ShieldCheck,
} from "lucide-react";
import { GiExpense } from "react-icons/gi";
import { MdOutlinePointOfSale } from "react-icons/md";
import { FcSalesPerformance } from "react-icons/fc";

/**
 * Sidebar/route configuration. `permission` (string) or `anyPermission`
 * (string[]) gate visibility client-side; the backend independently enforces
 * the same permission keys on every API call.
 */
export const navigation = [
  {
    title: "Dashboard",
    url: "/dashboard",
    icon: LayoutDashboard,
    permission: "dashboard.view",
  },
  {
    title: "Due Management",
    url: "/due-management",
    icon: CreditCard,
    anyPermission: ["customers.view_ledger", "suppliers.view_ledger"],
  },
  {
    title: "POS",
    url: "/",
    icon: MdOutlinePointOfSale,
    permission: "pos.view",
  },
  {
    title: "Reports",
    icon: BarChart3,
    anyPermission: [
      "reports.sales.view",
      "reports.purchase.view",
      "reports.profit.view",
      "reports.expense.view",
      "reports.inventory.view",
      "reports.financial.view",
    ],
    items: [
      {
        title: "All Reports Hub",
        url: "/reports",
        anyPermission: [
          "reports.sales.view",
          "reports.purchase.view",
          "reports.profit.view",
          "reports.expense.view",
          "reports.inventory.view",
          "reports.financial.view",
        ],
      },
      { title: "Shift Close (Z-Report)", url: "/reports?tab=register-close", permission: "reports.sales.view" },
      { title: "Sales Summary", url: "/reports?tab=sales-summary", permission: "reports.sales.view" },
      { title: "Hourly & Peak Hours", url: "/reports?tab=sales-hourly", permission: "reports.sales.view" },
      { title: "Sales by Invoice", url: "/reports?tab=sales-invoices", permission: "reports.sales.view" },
      { title: "Product Sales", url: "/reports?tab=sales-products", permission: "reports.sales.view" },
      { title: "Payment Breakdown", url: "/reports?tab=sales-payments", permission: "reports.sales.view" },
      { title: "Gross Profit & Margins", url: "/reports?tab=profit", permission: "reports.profit.view" },
      { title: "Customer Receivables", url: "/reports?tab=receivables", permission: "reports.financial.view" },
      { title: "Tax / VAT Reconciliation", url: "/reports?tab=tax", permission: "reports.financial.view" },
      { title: "Stock & Valuation", url: "/reports?tab=stock", permission: "reports.inventory.view" },
      { title: "Loss & Shrinkage", url: "/reports?tab=shrinkage", permission: "reports.inventory.view" },
      { title: "Batch & Expiry", url: "/reports?tab=batch-expiry", permission: "reports.inventory.view" },
      { title: "Purchase Summary", url: "/reports?tab=purchases-summary", permission: "reports.purchase.view" },
      { title: "Supplier Payables", url: "/reports?tab=supplier-payables", permission: "reports.purchase.view" },
    ],
  },
  {
    title: "Products",
    icon: Package,
    anyPermission: ["products.view", "products.create", "products.edit", "products.manage_variants", "inventory.adjust", "inventory.transfer"],
    items: [
      { title: "All Products", url: "/product", permission: "products.view" },
      { title: "Add Product", url: "/product/addproduct", permission: "products.create" },
      { title: "Stock Adjustment", url: "/product/stock-adjustment", permission: "inventory.adjust" },
      { title: "Categories", url: "/categories", permission: "products.view" },
      { title: "Brands", url: "/brands", permission: "products.view" },
      { title: "Units", url: "/units", permission: "products.view" },
      { title: "Variants", url: "/variants", permission: "products.manage_variants" },
      { title: "Stock Transfers", url: "/transfers", permission: "inventory.transfer" },
    ],
  },
  {
    title: "Sales",
    url: "/sales",
    icon: FcSalesPerformance,
    permission: "sales.view",
  },
  {
    title: "Contacts",
    icon: ContactRound,
    anyPermission: ["customers.view", "suppliers.view"],
    items: [
      { title: "Customers", url: "/customer", permission: "customers.view" },
      { title: "Suppliers", url: "/suppliers", permission: "suppliers.view" },
    ],
  },
  {
    title: "Expense",
    url: "/expense",
    icon: GiExpense,
    permission: "expenses.view",
  },
  {
    title: "Purchases",
    icon: Tags,
    anyPermission: ["purchases.view", "purchases.create"],
    items: [
      { title: "All Purchases", url: "/purchases", permission: "purchases.create" },
      { title: "Purchases List", url: "/purchases-list", permission: "purchases.view" },
    ],
  },
  {
    title: "Locations",
    url: "/locations",
    icon: MapPin,
    permission: "locations.view",
  },
  {
    title: "Users",
    url: "/users",
    icon: Users,
    permission: "users.view",
  },
  {
    title: "Roles & Permissions",
    url: "/roles",
    icon: ShieldCheck,
    permission: "roles.view",
  },
];
