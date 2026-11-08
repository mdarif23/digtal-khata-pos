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

export default router;

