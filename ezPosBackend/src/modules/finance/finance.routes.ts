import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusinessContext } from "../../middleware/business.js";
import { requireFullAccess } from "../../middleware/business.js";
import {
  requirePermission,
  requireAnyPermission,
} from "../../middleware/permissions.js";
import * as ctrl from "./finance.controller.js";
import * as ownerCtrl from "./finance.owner.controller.js";
import * as payrollCtrl from "./finance.payroll.controller.js";
import * as overviewCtrl from "./finance.overview.controller.js";
import * as toolsCtrl from "./finance.tools.controller.js";
import * as reportsCtrl from "./finance.reports.controller.js";

/**
 * Finance & Growth routes (Stage 3: ledger foundation). Business-scoped via
 * requireBusinessContext; location middleware intentionally omitted — the
 * ledger is business-level (line-level location dimensions are validated in
 * the services). Writes require an active subscription (requireFullAccess).
 */
const router = Router();

const read = [requireAuth, requireBusinessContext()] as const;
const write = [...read, requireFullAccess] as const;

// Status & activation
router.get("/api/finance/status", ...read, requireAnyPermission(["finance.view", "finance.overview.view"]), ctrl.getStatus);
router.post("/api/finance/activation", ...write, requirePermission("finance.activation.manage"), ctrl.activate);

// Financial overview, cash flow & growth analytics (Stage 6)
router.get("/api/finance/overview", ...read, requireAnyPermission(["finance.overview.view", "finance.profit.view"]), overviewCtrl.getOverview);
router.get("/api/finance/cash-flow", ...read, requirePermission("finance.overview.view"), overviewCtrl.getCashFlowReport);
router.get("/api/finance/growth", ...read, requirePermission("finance.profit.view"), overviewCtrl.getGrowth);

// Loans, assets & depreciation, balance sheet (Stage 7)
router.get("/api/finance/loans", ...read, requirePermission("loans.view"), toolsCtrl.listLoans);
router.post("/api/finance/loans", ...write, requirePermission("loans.manage"), toolsCtrl.createLoan);
router.get("/api/finance/loans/:id/repayments", ...read, requirePermission("loans.view"), toolsCtrl.listRepayments);
router.post("/api/finance/loans/:id/repayments", ...write, requirePermission("loans.manage"), toolsCtrl.recordRepayment);

router.get("/api/finance/assets", ...read, requirePermission("finance.assets.view"), toolsCtrl.listAssets);
router.post("/api/finance/assets", ...write, requirePermission("finance.assets.manage"), toolsCtrl.createAsset);
router.post("/api/finance/assets/depreciation/run", ...write, requirePermission("finance.assets.manage"), toolsCtrl.runDepreciation);

router.get("/api/finance/balance-sheet", ...read, requirePermission("finance.overview.view"), toolsCtrl.getBalanceSheet);

// Reports, reconciliation & audit trail (Stage 8). CSV via ?format=csv.
router.get("/api/finance/reports/pnl", ...read, requirePermission("finance.profit.view"), reportsCtrl.getPnl);
router.get("/api/finance/reports/owner-investments", ...read, requirePermission("finance.investment.view"), reportsCtrl.getOwnerInvestments);
router.get("/api/finance/reports/owner-withdrawals", ...read, requirePermission("finance.withdrawal.view"), reportsCtrl.getOwnerWithdrawals);
router.get("/api/finance/reports/profit-allocations", ...read, requirePermission("finance.profit.view"), reportsCtrl.getProfitAllocations);
router.get("/api/finance/reports/retained-earnings", ...read, requirePermission("finance.profit.view"), reportsCtrl.getRetainedEarnings);
router.get("/api/finance/reports/payroll", ...read, requirePermission("payroll.view"), reportsCtrl.getPayrollReport);
router.get("/api/finance/reports/salary-outstanding", ...read, requirePermission("payroll.view"), reportsCtrl.getSalaryOutstanding);
router.get("/api/finance/reports/loan-outstanding", ...read, requirePermission("loans.view"), reportsCtrl.getLoanOutstanding);
router.get("/api/finance/reports/budget-variance", ...read, requirePermission("budget.view"), reportsCtrl.getBudgetVariance);
router.get("/api/finance/reports/transactions", ...read, requirePermission("finance.journal.view"), reportsCtrl.getTransactions);
router.get("/api/finance/reconciliation", ...read, requirePermission("finance.reconcile.manage"), reportsCtrl.getReconciliation);
router.get("/api/finance/audit-log", ...read, requireAnyPermission(["finance.journal.view", "finance.view"]), reportsCtrl.getAuditTrail);

// Chart of accounts
router.get("/api/finance/accounts", ...read, requireAnyPermission(["finance.journal.view", "finance.accounts.manage"]), ctrl.listAccounts);
router.post("/api/finance/accounts", ...write, requirePermission("finance.accounts.manage"), ctrl.createAccount);
router.patch("/api/finance/accounts/:id", ...write, requirePermission("finance.accounts.manage"), ctrl.updateAccount);
router.post("/api/finance/accounts/:id/archive", ...write, requirePermission("finance.accounts.manage"), ctrl.archiveAccount);
router.get("/api/finance/accounts/balances", ...read, requirePermission("finance.journal.view"), ctrl.getBalances);

// Payment accounts (cash / bank / MFS)
router.get("/api/finance/payment-accounts", ...read, requireAnyPermission(["finance.journal.view", "finance.accounts.manage"]), ctrl.listPaymentAccounts);
router.post("/api/finance/payment-accounts", ...write, requirePermission("finance.accounts.manage"), ctrl.createPaymentAccount);
router.patch("/api/finance/payment-accounts/:id", ...write, requirePermission("finance.accounts.manage"), ctrl.updatePaymentAccount);

// Journal
router.get("/api/finance/journal-entries", ...read, requirePermission("finance.journal.view"), ctrl.listEntries);
router.get("/api/finance/journal-entries/:id", ...read, requirePermission("finance.journal.view"), ctrl.getEntry);
router.post("/api/finance/journal-entries", ...write, requirePermission("finance.journal.post"), ctrl.createEntry);
router.patch("/api/finance/journal-entries/:id", ...write, requirePermission("finance.journal.post"), ctrl.updateDraft);
router.post("/api/finance/journal-entries/:id/post", ...write, requirePermission("finance.journal.post"), ctrl.postDraft);
router.delete("/api/finance/journal-entries/:id", ...write, requirePermission("finance.journal.post"), ctrl.deleteDraft);
router.post("/api/finance/journal-entries/:id/reverse", ...write, requirePermission("finance.journal.reverse"), ctrl.reverseEntry);

// Periods
router.get("/api/finance/periods", ...read, requirePermission("finance.journal.view"), ctrl.listPeriods);
router.post("/api/finance/periods/:id/close", ...write, requirePermission("finance.period.close"), ctrl.closePeriod);
router.post("/api/finance/periods/:id/reopen", ...write, requirePermission("finance.period.reopen"), ctrl.reopenPeriod);

// Trial balance
router.get("/api/finance/trial-balance", ...read, requirePermission("finance.journal.view"), ctrl.getTrialBalance);

// ---------------------------------------------------------------------------
// Owner finance (Stage 4): owners, capital transactions, profit allocations.
// Investment/withdrawal management is deliberately separate from viewing —
// cashier roles hold none of these keys.
// ---------------------------------------------------------------------------

const ownerRead = [requireAuth, requireBusinessContext()] as const;
const ownerWrite = [...ownerRead, requireFullAccess] as const;

router.get("/api/finance/owners", ...ownerRead, requireAnyPermission(["finance.investment.view", "finance.withdrawal.view", "finance.profit.view"]), ownerCtrl.listOwners);
router.post("/api/finance/owners", ...ownerWrite, requirePermission("finance.investment.manage"), ownerCtrl.createOwner);
router.patch("/api/finance/owners/:id", ...ownerWrite, requirePermission("finance.investment.manage"), ownerCtrl.updateOwner);

router.get("/api/finance/capital-transactions", ...ownerRead, requireAnyPermission(["finance.investment.view", "finance.withdrawal.view"]), ownerCtrl.listCapitalTransactions);
router.post("/api/finance/capital-transactions", ...ownerWrite, requirePermission("finance.investment.manage"), ownerCtrl.recordCapitalTransaction);
router.get("/api/finance/capital-summary", ...ownerRead, requireAnyPermission(["finance.investment.view", "finance.withdrawal.view"]), ownerCtrl.getCapitalSummary);

router.get("/api/finance/profit", ...ownerRead, requirePermission("finance.profit.view"), ownerCtrl.getProfit);
router.get("/api/finance/profit-allocations", ...ownerRead, requirePermission("finance.profit.view"), ownerCtrl.listAllocations);
router.post("/api/finance/profit-allocations", ...ownerWrite, requirePermission("finance.profit.allocate"), ownerCtrl.createAllocation);
router.post("/api/finance/profit-allocations/:id/reverse", ...ownerWrite, requirePermission("finance.profit.allocate"), ownerCtrl.reverseAllocation);
router.post("/api/finance/profit-allocations/lines/:id/realize", ...ownerWrite, requirePermission("finance.profit.allocate"), ownerCtrl.realizeAllocationLine);

// ---------------------------------------------------------------------------
// Staff & Payroll (Stage 5): employees, structures, advances, periods,
// payments, payslips. Cashier roles hold no payroll keys.
// ---------------------------------------------------------------------------

const payrollRead = [requireAuth, requireBusinessContext()] as const;
const payrollWrite = [...payrollRead, requireFullAccess] as const;

router.get("/api/payroll/employees", ...payrollRead, requirePermission("payroll.view"), payrollCtrl.listEmployees);
router.get("/api/payroll/employees/:id", ...payrollRead, requirePermission("payroll.view"), payrollCtrl.getEmployee);
router.post("/api/payroll/employees", ...payrollWrite, requirePermission("payroll.manage"), payrollCtrl.createEmployee);
router.patch("/api/payroll/employees/:id", ...payrollWrite, requirePermission("payroll.manage"), payrollCtrl.updateEmployee);
router.post("/api/payroll/employees/:id/salary-structures", ...payrollWrite, requirePermission("payroll.manage"), payrollCtrl.createSalaryStructure);
router.post("/api/payroll/employees/:id/advances", ...payrollWrite, requirePermission("payroll.manage"), payrollCtrl.giveAdvance);
router.get("/api/payroll/employees/:id/advances", ...payrollRead, requirePermission("payroll.view"), payrollCtrl.listAdvances);

router.get("/api/payroll/periods", ...payrollRead, requirePermission("payroll.view"), payrollCtrl.listPeriods);
router.get("/api/payroll/periods/:id", ...payrollRead, requirePermission("payroll.view"), payrollCtrl.getPeriod);
router.post("/api/payroll/periods", ...payrollWrite, requirePermission("payroll.process"), payrollCtrl.createPeriod);
router.patch("/api/payroll/periods/:id/records/:recordId", ...payrollWrite, requirePermission("payroll.process"), payrollCtrl.updateRecord);
router.post("/api/payroll/periods/:id/approve", ...payrollWrite, requirePermission("payroll.approve"), payrollCtrl.approvePeriod);
router.post("/api/payroll/periods/:id/cancel", ...payrollWrite, requirePermission("payroll.approve"), payrollCtrl.cancelPeriod);
router.post("/api/payroll/periods/:id/reopen", ...payrollWrite, requirePermission("payroll.approve"), payrollCtrl.reopenPeriod);

router.post("/api/payroll/records/:recordId/payments", ...payrollWrite, requirePermission("payroll.pay"), payrollCtrl.recordPayment);
router.post("/api/payroll/payments/:id/void", ...payrollWrite, requirePermission("payroll.pay"), payrollCtrl.voidPayment);
router.get("/api/payroll/records/:recordId/payslip", ...payrollRead, requirePermission("payroll.view"), payrollCtrl.getPayslip);

export default router;
