import { env } from "../config/env.js";
import { runSubscriptionSweeps } from "./subscriptionJobs.js";
import { runCommerceSweeps } from "./commerceJobs.js";
import { runWarrantySweeps } from "./warrantyJobs.js";
import { runIntegrationSweeps } from "./integrationJobs.js";
import { processWebhookDeliveries } from "../modules/webhooks/webhookDelivery.service.js";
import { generateDueExpensesForAllBusinesses } from "../modules/expenses/expenses.templates.service.js";
import { runBackupSweeps } from "../modules/backups/backups.service.js";
import { runBudgetAlertSweeps } from "../modules/expenses/expenses.budgets.alerts.js";
import { runAssetDepreciationSweeps } from "../modules/finance/finance.tools.service.js";

/**
 * In-process scheduler: sweeps subscription lifecycle jobs on a fixed
 * interval. Fine for a single instance; before horizontal scaling, move to
 * a dedicated worker (the sweeps themselves are SKIP LOCKED-safe already).
 */
let timer: NodeJS.Timeout | null = null;
let running = false;

export function startScheduler(): void {
  if (!env.jobsEnabled) {
    console.info("Background jobs disabled (JOBS_ENABLED=false).");
    return;
  }
  if (timer) return;
  const intervalMs = env.jobsIntervalMinutes * 60 * 1000;
  timer = setInterval(() => {
    if (running) return; // never overlap sweeps
    running = true;
    void Promise.all([
      runSubscriptionSweeps(),
      runCommerceSweeps(),
      runIntegrationSweeps(),
      processWebhookDeliveries(),
      generateDueExpensesForAllBusinesses(),
      runBackupSweeps(),
      runBudgetAlertSweeps(),
      runAssetDepreciationSweeps(),
    ])
      .then(([sub, commerce, integrations, deliveries, expenses, backups, warranty]) => {
        const total =
          sub.expiredTrials +
          sub.trialReminders +
          sub.renewalReminders +
          sub.graceSuspensions +
          commerce.reservationsExpired +
          commerce.heldSalesExpired +
          commerce.expiryNotifications +
          integrations.processedJobs +
          integrations.stockPushes +
          integrations.customerPushes +
          deliveries.delivered +
          deliveries.failed +
          expenses.expensesGenerated +
          backups.backupsStarted +
          backups.expiredDeleted;
        if (total > 0) {
          console.info("Scheduled sweeps:", { ...sub, ...commerce, expenses, backups, warranty });
        }
      })
      .catch((err) => console.error("Scheduled sweeps failed:", err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  // Boot catch-up: templates that came due while the server was down are
  // generated immediately (idempotent — safe across restarts).
  void generateDueExpensesForAllBusinesses().catch((err) =>
    console.error("Expense template boot catch-up failed:", err),
  );
  console.info(
    `Background jobs scheduled every ${env.jobsIntervalMinutes} minute(s).`,
  );
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
