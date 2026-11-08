import { sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { expenseBudgets } from "../../db/schema/expenseBudgets.js";
import { notifyInTx } from "../../services/notifications.js";

/**
 * Budget threshold alerts (Finance & Growth Stage 7, Phase 6). A scheduler
 * sweep checks every business's budgets whose CURRENT period (month /
 * quarter / year per period_type) has utilization at or above the budget's
 * configured warning threshold and raises one deduplicated notification
 * per budget per day.
 */

export async function runBudgetAlertSweeps(): Promise<{ alertsRaised: number }> {
  // Businesses that have at least one budget.
  const businesses = await db
    .selectDistinct({ businessId: expenseBudgets.businessId })
    .from(expenseBudgets);

  let alertsRaised = 0;
  for (const { businessId } of businesses) {
    alertsRaised += await sweepBusinessBudgets(businessId);
  }
  return { alertsRaised };
}

async function sweepBusinessBudgets(businessId: number): Promise<number> {
  // Budgets whose current period contains today, with actual utilization.
  const rows = await db.execute(sql`
    SELECT
      b.id,
      b.period_type AS "periodType",
      b.month,
      b.amount,
      b.warning_threshold_percent AS "warningThresholdPercent",
      round(coalesce(sum(e.amount), 0)::numeric, 2)::float8 AS "actualAmount"
    FROM expense_budgets b
    LEFT JOIN expenses e
      ON e.business_id = b.business_id
      AND e.deleted_at IS NULL
      AND date_trunc(
        (CASE b.period_type WHEN 'quarterly' THEN 'quarter' WHEN 'yearly' THEN 'year' ELSE 'month' END),
        e.expense_date
      )::date = b.month
      AND (b.category_id IS NULL OR e.category_id = b.category_id)
      AND (b.location_id IS NULL OR e.location_id = b.location_id)
    WHERE b.business_id = ${businessId}
      AND b.month <= CURRENT_DATE
      AND (b.month + (CASE b.period_type WHEN 'quarterly' THEN interval '3 months' WHEN 'yearly' THEN interval '1 year' ELSE interval '1 month' END)) > CURRENT_DATE
    GROUP BY b.id
    HAVING coalesce(sum(e.amount), 0) >= b.amount * (b.warning_threshold_percent / 100.0)
  `);

  let raised = 0;
  for (const row of rows.rows) {
    const r = row as Record<string, unknown>;
    const budgetId = Number(r.id);
    const amount = Number(r.amount ?? 0);
    const actualAmount = Number(r.actualAmount ?? 0);
    const utilization =
      amount > 0 ? Math.round((actualAmount / amount) * 100) : 100;
    await db.transaction(async (tx) => {
      const notified = await notifyInTx(tx, {
        businessId,
        kind: "budget_alert",
        severity: actualAmount > amount ? "critical" : "warning",
        title:
          actualAmount > amount
            ? "Budget exceeded"
            : "Budget threshold reached",
        body: `A ${String(r.periodType)} budget is at ${utilization}% utilization (${actualAmount.toFixed(2)} of ${amount.toFixed(2)}).`,
        payload: { budgetId, utilization, amount, actualAmount },
        dedupeKey: `budget-alert-${budgetId}`,
      });
      if (notified != null) raised += 1;
    });
  }
  return raised;
}
