import express from "express";
import * as expensesController from "./expenses.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
// Location-aware: the X-Location-Id header (or the business default) is
// validated against membership + assignment before any handler runs. The
// list/export endpoints additionally accept an explicit ?locationId= filter
// (validated against the caller's accessible locations).
const read = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
] as const;
const write = [...read, requireFullAccess] as const;

// Static segments first — /export, /analytics and /categories must not be
// captured by /:id.
router.get(
  "/api/expenses",
  ...read,
  requirePermission("expenses.view"),
  expensesController.getExpenses,
);
router.get(
  "/api/expenses/analytics",
  ...read,
  requirePermission("expenses.view"),
  expensesController.getExpenseAnalytics,
);
router.get(
  "/api/expenses/export",
  ...read,
  requirePermission("expenses.view"),
  expensesController.exportExpenses,
);
router.get(
  "/api/expenses/:id",
  ...read,
  requirePermission("expenses.view"),
  expensesController.getExpense,
);
router.post(
  "/api/expenses",
  ...write,
  requirePermission("expenses.create"),
  expensesController.createExpense,
);
router.patch(
  "/api/expenses/:id",
  ...write,
  requirePermission("expenses.edit"),
  expensesController.updateExpense,
);
// Soft void — the expense row is retained (deleted_at) so historical reports
// stay reproducible; requires the delete permission.
router.delete(
  "/api/expenses/:id",
  ...write,
  requirePermission("expenses.delete"),
  expensesController.deleteExpense,
);
// Static segment before /:id/payments/:paymentId — same path prefix, so
// register list/detail first.
router.get(
  "/api/expenses/:id/payments",
  ...read,
  requirePermission("expenses.view"),
  expensesController.getExpensePayments,
);
// Recording a settlement needs the dedicated expenses.pay permission
// (accountant preset holds it; cashiers do not).
router.post(
  "/api/expenses/:id/payments",
  ...write,
  requirePermission("expenses.pay"),
  expensesController.createExpensePayment,
);
// Corrective payment void is a destructive act — expenses.delete (void right).
router.delete(
  "/api/expenses/:id/payments/:paymentId",
  ...write,
  requirePermission("expenses.delete"),
  expensesController.deleteExpensePayment,
);
// Attachments: presign (expenses.edit to add), register, and private
// downloads (expenses.view) / delete (expenses.delete) by attachment id.
router.post(
  "/api/expenses/:id/attachments/presign",
  ...write,
  requirePermission("expenses.edit"),
  expensesController.presignExpenseAttachment,
);
router.post(
  "/api/expenses/:id/attachments",
  ...write,
  requirePermission("expenses.edit"),
  expensesController.registerExpenseAttachment,
);
router.get(
  "/api/attachments/:attachmentId/url",
  ...read,
  requirePermission("expenses.view"),
  expensesController.getAttachmentDownloadUrl,
);
router.delete(
  "/api/attachments/:attachmentId",
  ...write,
  requirePermission("expenses.delete"),
  expensesController.deleteAttachment,
);
// Recurring templates: manage = expenses.create (they generate future
// expenses); archive = expenses.edit; manual generation = expenses.create.
// The background scheduler runs the same service without HTTP.
router.get(
  "/api/expense_templates",
  ...read,
  requirePermission("expenses.view"),
  expensesController.getExpenseTemplates,
);
router.post(
  "/api/expense_templates",
  ...write,
  requirePermission("expenses.create"),
  expensesController.createExpenseTemplate,
);
router.patch(
  "/api/expense_templates/:id",
  ...write,
  requirePermission("expenses.edit"),
  expensesController.updateExpenseTemplate,
);
router.post(
  "/api/expense_templates/:id/archive",
  ...write,
  requirePermission("expenses.edit"),
  expensesController.archiveExpenseTemplate,
);
router.post(
  "/api/expense_templates/:id/generate",
  ...write,
  requirePermission("expenses.create"),
  expensesController.runExpenseTemplate,
);
// Budgets: plans, not financial records — manage = expenses.edit.
router.get(
  "/api/expense_budgets",
  ...read,
  requirePermission("expenses.view"),
  expensesController.getExpenseBudgets,
);
router.get(
  "/api/expense_budgets/usage",
  ...read,
  requirePermission("expenses.view"),
  expensesController.getExpenseBudgetUsage,
);
router.post(
  "/api/expense_budgets",
  ...write,
  requirePermission("expenses.edit"),
  expensesController.createExpenseBudget,
);
router.patch(
  "/api/expense_budgets/:id",
  ...write,
  requirePermission("expenses.edit"),
  expensesController.updateExpenseBudget,
);
router.delete(
  "/api/expense_budgets/:id",
  ...write,
  requirePermission("expenses.edit"),
  expensesController.deleteExpenseBudget,
);
router.post(
  "/api/expense_categories",
  ...write,
  requirePermission("expenses.create"),
  expensesController.createExpenseCategory,
);
router.get(
  "/api/expense_categories",
  ...read,
  requirePermission("expenses.view"),
  expensesController.getExpenseCategories,
);
// Category lifecycle management is taxonomy editing — expenses.edit gates it
// (accountant preset holds it; referenced categories are archived, never removed).
router.patch(
  "/api/expense_categories/:id",
  ...write,
  requirePermission("expenses.edit"),
  expensesController.updateExpenseCategory,
);
router.post(
  "/api/expense_categories/:id/archive",
  ...write,
  requirePermission("expenses.edit"),
  expensesController.archiveExpenseCategory,
);
router.post(
  "/api/expense_categories/:id/restore",
  ...write,
  requirePermission("expenses.edit"),
  expensesController.restoreExpenseCategory,
);
export default router;
