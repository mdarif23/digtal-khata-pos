import { expenseBudgets } from "../../db/schema/expenseBudgets.js";
import { db } from "../../db/schema/index.js";
import { and, eq, sql } from "drizzle-orm";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/handleError.js";
import { recordAudit } from "../../services/audit.js";
import type { ExpenseBudgetWriteInput } from "./expenses.schema.js";

/**
 * Monthly expense budgets (Phase 6). Plans, not financial records — hard
 * delete is fine. Usage is always computed from non-voided expenses at read
 * time (accrual on expense_date), never stored, so numbers can't drift.
 */

function monthStart(month: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(month)) {
    throw new BadRequestError("Month must be formatted YYYY-MM-DD.");
  }
  const day = Number(month.slice(8, 10));
  if (day !== 1) {
    throw new BadRequestError("Budget month must be the first day of the month.");
  }
  return month;
}

export async function listExpenseBudgets(businessId: number, month: string) {
  const monthDate = monthStart(month);
  // One query: budgets of the month joined against their scoped actual
  // spend (accrual, non-voided). NULL scope = all categories/locations.
  const rows = await db.execute(sql`
    SELECT
      b.id,
      b.category_id AS "categoryId",
      ec.category_name AS "categoryName",
      b.location_id AS "locationId",
      l.name AS "locationName",
      b.month,
      b.amount,
      round(coalesce(sum(e.amount), 0)::numeric, 2)::float8 AS "actualAmount",
      count(e.id)::int AS "expenseCount"
    FROM expense_budgets b
    LEFT JOIN expenses e
      ON e.business_id = b.business_id
      AND e.deleted_at IS NULL
      AND date_trunc('month', e.expense_date)::date = b.month
      AND (b.category_id IS NULL OR e.category_id = b.category_id)
      AND (b.location_id IS NULL OR e.location_id = b.location_id)
    LEFT JOIN expense_categories ec ON ec.id = b.category_id
    LEFT JOIN locations l ON l.id = b.location_id
    WHERE b.business_id = ${businessId}
      AND b.month = ${monthDate}::date
    GROUP BY b.id, ec.category_name, l.name
    ORDER BY b.amount DESC
  `);
  return rows.rows.map((row) => {
    const r = row as Record<string, unknown>;
    const amount = Number(r.amount ?? 0);
    const actualAmount = Number(r.actualAmount ?? 0);
    return {
      id: Number(r.id),
      categoryId: (r.categoryId as number | null) ?? null,
      categoryName: (r.categoryName as string | null) ?? null,
      locationId: (r.locationId as number | null) ?? null,
      locationName: (r.locationName as string | null) ?? null,
      month: r.month as string,
      amount,
      actualAmount,
      remainingAmount: Math.round((amount - actualAmount) * 100) / 100,
      utilizationPercent:
        amount > 0
          ? Math.round((actualAmount / amount) * 100 * 100) / 100
          : null,
      overBudget: actualAmount > amount,
      expenseCount: Number(r.expenseCount ?? 0),
    };
  });
}

async function assertScopeAvailable(
  businessId: number,
  categoryId: number | null,
  locationId: number | null,
  month: string,
  excludeId: number | null,
) {
  const conditions = [
    eq(expenseBudgets.businessId, businessId),
    eq(expenseBudgets.month, month),
    categoryId === null
      ? sql`${expenseBudgets.categoryId} IS NULL`
      : eq(expenseBudgets.categoryId, categoryId),
    locationId === null
      ? sql`${expenseBudgets.locationId} IS NULL`
      : eq(expenseBudgets.locationId, locationId),
  ];
  if (excludeId !== null) {
    conditions.push(sql`${expenseBudgets.id} <> ${excludeId}`);
  }
  const [duplicate] = await db
    .select({ id: expenseBudgets.id })
    .from(expenseBudgets)
    .where(and(...conditions))
    .limit(1);
  if (duplicate) {
    throw new ConflictError(
      "A budget already exists for this scope and month.",
    );
  }
}

export async function createExpenseBudget(
  businessId: number,
  createdBy: number,
  data: ExpenseBudgetWriteInput,
) {
  const month = monthStart(data.month);
  const locationId = data.location_id ?? null;
  await assertScopeAvailable(businessId, data.category_id, locationId, month, null);
  const insertedBudgets = await db
    .insert(expenseBudgets)
    .values({
      businessId,
      categoryId: data.category_id,
      locationId,
      month,
      amount: data.amount,
      createdBy,
    })
    .returning({ id: expenseBudgets.id });
  const budget = insertedBudgets[0];
  if (!budget) {
    throw new NotFoundError("Expense budget could not be created.");
  }
  await recordAudit({
    businessId,
    actorUserId: createdBy,
    action: "expense.budget.create",
    entityType: "expense_budget",
    entityId: budget.id,
    metadata: { month, amount: data.amount, categoryId: data.category_id, locationId: data.location_id },
  });
  return budget;
}

export async function updateExpenseBudget(
  businessId: number,
  id: number,
  updatedBy: number,
  data: ExpenseBudgetWriteInput,
) {
  const month = monthStart(data.month);
  const budgetLocationId = data.location_id ?? null;
  const [existing] = await db
    .select({ id: expenseBudgets.id })
    .from(expenseBudgets)
    .where(and(eq(expenseBudgets.id, id), eq(expenseBudgets.businessId, businessId)))
    .limit(1);
  if (!existing) {
    throw new NotFoundError("Expense budget not found");
  }
  await assertScopeAvailable(businessId, data.category_id, budgetLocationId, month, id);
  const updatedBudgets = await db
    .update(expenseBudgets)
    .set({
      categoryId: data.category_id,
      locationId: budgetLocationId,
      month,
      amount: data.amount,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(and(eq(expenseBudgets.id, id), eq(expenseBudgets.businessId, businessId)))
    .returning({ id: expenseBudgets.id });
  const updated = updatedBudgets[0];
  if (!updated) {
    throw new NotFoundError("Expense budget not found");
  }
  await recordAudit({
    businessId,
    actorUserId: updatedBy,
    action: "expense.budget.update",
    entityType: "expense_budget",
    entityId: id,
    metadata: { month, amount: data.amount },
  });
  return updated;
}

export async function deleteExpenseBudget(
  businessId: number,
  id: number,
  deletedBy: number,
) {
  const [deleted] = await db
    .delete(expenseBudgets)
    .where(and(eq(expenseBudgets.id, id), eq(expenseBudgets.businessId, businessId)))
    .returning({ id: expenseBudgets.id });
  if (!deleted) {
    throw new NotFoundError("Expense budget not found");
  }
  await recordAudit({
    businessId,
    actorUserId: deletedBy,
    action: "expense.budget.delete",
    entityType: "expense_budget",
    entityId: id,
    metadata: {},
  });
  return deleted;
}

/** Budget usage rows for the analytics panel (latest months first). */
export async function getBudgetUsage(
  businessId: number,
  months: number,
  locationId: number | undefined,
) {
  // A business-wide (NULL-location) budget still applies under a location
  // filter, so the condition is OR'd, and dropped entirely when unfiltered.
  const locationCondition =
    locationId !== undefined
      ? sql`AND (b.location_id IS NULL OR b.location_id = ${locationId})`
      : sql``;
  const rows = await db.execute(sql`
    WITH months AS (
      SELECT generate_series(
        date_trunc('month', CURRENT_DATE)::date - ((${months - 1})::int * interval '1 month'),
        date_trunc('month', CURRENT_DATE)::date,
        interval '1 month'
      )::date AS month
    )
    SELECT
      b.id,
      ec.category_name AS "categoryName",
      l.name AS "locationName",
      b.month,
      b.amount,
      round(coalesce(sum(e.amount), 0)::numeric, 2)::float8 AS "actualAmount"
    FROM months m
    JOIN expense_budgets b
      ON b.business_id = ${businessId} AND b.month = m.month
      ${locationCondition}
    LEFT JOIN expenses e
      ON e.business_id = b.business_id
      AND e.deleted_at IS NULL
      AND date_trunc('month', e.expense_date)::date = b.month
      AND (b.category_id IS NULL OR e.category_id = b.category_id)
      AND (b.location_id IS NULL OR e.location_id = b.location_id)
    LEFT JOIN expense_categories ec ON ec.id = b.category_id
    LEFT JOIN locations l ON l.id = b.location_id
    GROUP BY b.id, ec.category_name, l.name
    ORDER BY b.month DESC, b.amount DESC
  `);
  return rows.rows.map((row) => {
    const r = row as Record<string, unknown>;
    const amount = Number(r.amount ?? 0);
    const actualAmount = Number(r.actualAmount ?? 0);
    return {
      id: Number(r.id),
      categoryName: (r.categoryName as string | null) ?? null,
      locationName: (r.locationName as string | null) ?? null,
      month: r.month as string,
      amount,
      actualAmount,
      utilizationPercent:
        amount > 0
          ? Math.round((actualAmount / amount) * 100 * 100) / 100
          : null,
      overBudget: actualAmount > amount,
    };
  });
}
