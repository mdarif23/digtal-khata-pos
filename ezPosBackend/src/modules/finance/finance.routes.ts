import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusinessContext } from "../../middleware/business.js";
import { requireFullAccess } from "../../middleware/business.js";
import {
  requirePermission,
  requireAnyPermission,
} from "../../middleware/permissions.js";
import * as ctrl from "./finance.controller.js";

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

export default router;
