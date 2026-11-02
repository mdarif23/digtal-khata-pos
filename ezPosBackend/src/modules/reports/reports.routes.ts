import express from "express";
import * as reportsController from "./reports.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusinessContext } from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";
import { requireFeature } from "../../middleware/entitlements.js";

const router = express.Router();

// Reports are read-only: authenticated + verified owner membership + tenant
// context. They remain available after trial expiry per the subscription
// policy. Every report query is scoped to req.membership.businessId.
const read = [requireAuth, requireBusinessContext()] as const;

// Advanced financial reports require the plan's advancedReports
// entitlement: profit, tax reconciliation, and cross-location comparison.
const advanced = [
  ...read,
  requirePermission("reports.financial.view"),
  requireFeature("advancedReports"),
] as const;

// Sales Reports
router.get(
  "/api/reports/sales/summary",
  ...read,
  requirePermission("reports.sales.view"),
  reportsController.getSalesSummary,
);
router.get(
  "/api/reports/sales/hourly",
  ...read,
  requirePermission("reports.sales.view"),
  reportsController.getHourlySales,
);
router.get(
  "/api/reports/sales/invoices",
  ...read,
  requirePermission("reports.sales.view"),
  reportsController.getSalesByInvoice,
);
router.get(
  "/api/reports/sales/products",
  ...read,
  requirePermission("reports.sales.view"),
  reportsController.getProductSales,
);
router.get(
  "/api/reports/sales/customers",
  ...read,
  requirePermission("reports.sales.view"),
  reportsController.getCustomerSales,
);
router.get(
  "/api/reports/sales/payments",
  ...read,
  requirePermission("reports.sales.view"),
  reportsController.getPaymentMethods,
);
router.get(
  "/api/reports/sales/refunds",
  ...read,
  requirePermission("reports.sales.view"),
  reportsController.getSaleRefunds,
);

// Financial Reports
router.get(
  "/api/reports/financial/profit",
  ...advanced,
  reportsController.getProfit,
);
router.get(
  "/api/reports/financial/expenses",
  ...read,
  requirePermission("reports.expense.view"),
  reportsController.getExpenses,
);
router.get(
  "/api/reports/financial/receivables",
  ...read,
  requirePermission("reports.financial.view"),
  reportsController.getCustomerReceivables,
);
router.get(
  "/api/reports/financial/tax",
  ...advanced,
  reportsController.getTaxReconciliation,
);
router.get(
  "/api/reports/financial/register-close",
  ...read,
  requirePermission("reports.sales.view"),
  reportsController.getRegisterClose,
);

// Inventory Reports
router.get(
  "/api/reports/inventory/stock",
  ...read,
  requirePermission("reports.inventory.view"),
  reportsController.getStock,
);
router.get(
  "/api/reports/inventory/movements",
  ...read,
  requirePermission("reports.inventory.view"),
  reportsController.getStockMovements,
);
router.get(
  "/api/reports/inventory/batches",
  ...read,
  requirePermission("reports.inventory.view"),
  reportsController.getBatchExpiry,
);
// Advanced analytics (Module 15)
router.get(
  "/api/reports/analytics/channels",
  ...read,
  requirePermission("reports.financial.view"),
  reportsController.getChannelPerformance,
);
router.get(
  "/api/reports/analytics/clv",
  ...read,
  requirePermission("reports.financial.view"),
  reportsController.getCustomerLifetimeValue,
);
router.get(
  "/api/reports/analytics/retention",
  ...read,
  requirePermission("reports.financial.view"),
  reportsController.getCustomerRetention,
);
router.get(
  "/api/reports/analytics/staff",
  ...read,
  requirePermission("reports.financial.view"),
  reportsController.getStaffPerformance,
);
router.get(
  "/api/reports/analytics/forecast",
  ...read,
  requirePermission("reports.financial.view"),
  reportsController.getSalesForecast,
);
router.get(
  "/api/reports/inventory/aging",
  ...read,
  requirePermission("reports.inventory.view"),
  reportsController.getInventoryAging,
);
router.get(
  "/api/reports/inventory/dead-stock",
  ...read,
  requirePermission("reports.inventory.view"),
  reportsController.getDeadStock,
);
router.get(
  "/api/reports/inventory/shrinkage",
  ...read,
  requirePermission("reports.inventory.view"),
  reportsController.getInventoryShrinkage,
);

// Location comparison spans every location — financial scope required.
router.get(
  "/api/reports/locations/comparison",
  ...advanced,
  reportsController.getLocationComparison
);

// Purchase Reports
router.get(
  "/api/reports/purchases/summary",
  ...read,
  requirePermission("reports.purchase.view"),
  reportsController.getPurchaseSummary,
);
router.get(
  "/api/reports/purchases/payables",
  ...read,
  requirePermission("reports.purchase.view"),
  reportsController.getSupplierPayables,
);

export default router;
