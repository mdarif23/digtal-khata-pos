import { expenses } from "../../db/schema/expenses.js";
import { expenseCategories } from "../../db/schema/expenseCategories.js";
import { locations } from "../../db/schema/locations.js";
import { db } from "../../db/schema/index.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { ExpenseAnalyticsQuery } from "./expenses.schema.js";

/**
 * Expense analytics (Phase 5) — every number below is a database aggregate
 * over business-scoped, non-voided rows. Accrual semantics: amounts bucket by
 * expense_date (the cost incurred), matching the dashboard's net-profit
 * definition; paid/due splits come from the settlement ledger mirror.
 */

const MONTHS_BACK = 12;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth() - (MONTHS_BACK - 1), 1);
  return { from: isoDate(from), to: isoDate(to) };
}

function scopeConditions(
  businessId: number,
  locationId: number | undefined,
  from: string,
  to: string,
) {
  return and(
    eq(expenses.businessId, businessId),
    isNull(expenses.deletedAt),
    sql`${expenses.expenseDate} >= ${from}::date`,
    sql`${expenses.expenseDate} <= ${to}::date`,
    ...(locationId ? [eq(expenses.locationId, locationId)] : []),
  )!;
}

function round2(value: unknown): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export async function getExpenseAnalytics(
  businessId: number,
  locationId: number | undefined,
  query: ExpenseAnalyticsQuery,
) {
  const range = {
    from: query.date_from ?? defaultRange().from,
    to: query.date_to ?? defaultRange().to,
  };
  const granularity = query.granularity;
  const where = scopeConditions(businessId, locationId, range.from, range.to);

  // -- Totals over the range ------------------------------------------------
  const [totalsRow] = await db
    .select({
      totalCount: sql<number>`count(*)::int`,
      totalAmount: sql<number>`round(coalesce(sum(${expenses.amount}), 0)::numeric, 2)::float8`,
      totalPaid: sql<number>`round(coalesce(sum(${expenses.paidAmount}), 0)::numeric, 2)::float8`,
      unpaidCount: sql<number>`count(*) filter (where ${expenses.paymentStatus} = 'unpaid')::int`,
      partialCount: sql<number>`count(*) filter (where ${expenses.paymentStatus} = 'partial')::int`,
      paidCount: sql<number>`count(*) filter (where ${expenses.paymentStatus} = 'paid')::int`,
    })
    .from(expenses)
    .where(where);
  const totalAmount = round2(totalsRow?.totalAmount);
  const totalPaid = round2(totalsRow?.totalPaid);
  const totalCount = Number(totalsRow?.totalCount ?? 0);

  // -- Calendar-month comparison (dashboard-consistent accrual) -------------
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthStart = `${prevMonthDate.getFullYear()}-${String(
    prevMonthDate.getMonth() + 1,
  ).padStart(2, "0")}-01`;
  const [comparisonRow] = await db
    .select({
      currentAmount: sql<number>`round(coalesce(sum(${expenses.amount}) filter (
        where ${expenses.expenseDate} >= ${monthStart}::date
      ), 0)::numeric, 2)::float8`,
      previousAmount: sql<number>`round(coalesce(sum(${expenses.amount}) filter (
        where ${expenses.expenseDate} >= ${prevMonthStart}::date
          AND ${expenses.expenseDate} < ${monthStart}::date
      ), 0)::numeric, 2)::float8`,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.businessId, businessId),
        isNull(expenses.deletedAt),
        ...(locationId ? [eq(expenses.locationId, locationId)] : []),
      ),
    );
  const currentAmount = round2(comparisonRow?.currentAmount);
  const previousAmount = round2(comparisonRow?.previousAmount);

  // -- Trend series bucketed by day/week/month ------------------------------
  const series = await db.execute(sql`
    SELECT
      date_trunc(${granularity}, ${expenses.expenseDate})::date::text AS bucket,
      count(*)::int AS count,
      round(coalesce(sum(${expenses.amount}), 0)::numeric, 2)::float8 AS amount,
      round(coalesce(sum(${expenses.paidAmount}), 0)::numeric, 2)::float8 AS paid
    FROM ${expenses}
    WHERE ${where}
    GROUP BY 1
    ORDER BY 1
  `);

  // -- Breakdowns -----------------------------------------------------------
  const categories = await db
    .select({
      categoryId: expenses.categoryId,
      categoryName: expenseCategories.categoryName,
      amount: sql<number>`round(coalesce(sum(${expenses.amount}), 0)::numeric, 2)::float8`,
      paid: sql<number>`round(coalesce(sum(${expenses.paidAmount}), 0)::numeric, 2)::float8`,
      count: sql<number>`count(*)::int`,
    })
    .from(expenses)
    .leftJoin(
      expenseCategories,
      and(
        eq(expenses.categoryId, expenseCategories.id),
        eq(expenseCategories.businessId, businessId),
      ),
    )
    .where(where)
    .groupBy(expenses.categoryId, expenseCategories.categoryName)
    .orderBy(sql`sum(${expenses.amount}) desc nulls last`);

  const paymentMethods = await db
    .select({
      method: expenses.paymentMethod,
      amount: sql<number>`round(coalesce(sum(${expenses.amount}), 0)::numeric, 2)::float8`,
      paid: sql<number>`round(coalesce(sum(${expenses.paidAmount}), 0)::numeric, 2)::float8`,
      count: sql<number>`count(*)::int`,
    })
    .from(expenses)
    .where(where)
    .groupBy(expenses.paymentMethod)
    .orderBy(sql`sum(${expenses.amount}) desc nulls last`);

  const locationRows = await db
    .select({
      locationId: expenses.locationId,
      locationName: locations.name,
      amount: sql<number>`round(coalesce(sum(${expenses.amount}), 0)::numeric, 2)::float8`,
      paid: sql<number>`round(coalesce(sum(${expenses.paidAmount}), 0)::numeric, 2)::float8`,
      count: sql<number>`count(*)::int`,
    })
    .from(expenses)
    .leftJoin(locations, eq(expenses.locationId, locations.id))
    .where(where)
    .groupBy(expenses.locationId, locations.name)
    .orderBy(sql`sum(${expenses.amount}) desc nulls last`);

  return {
    range: { ...range, granularity },
    totals: {
      totalCount,
      totalAmount,
      totalPaid,
      totalDue: round2(totalAmount - totalPaid),
      averageAmount: totalCount > 0 ? round2(totalAmount / totalCount) : 0,
      unpaidCount: Number(totalsRow?.unpaidCount ?? 0),
      partialCount: Number(totalsRow?.partialCount ?? 0),
      paidCount: Number(totalsRow?.paidCount ?? 0),
    },
    comparison: {
      currentMonth: monthStart,
      currentAmount,
      previousAmount,
      growthPercent:
        previousAmount > 0
          ? round2(((currentAmount - previousAmount) / previousAmount) * 100)
          : null,
    },
    series: series.rows as Array<{
      bucket: string;
      count: number;
      amount: number;
      paid: number;
    }>,
    categories,
    paymentMethods,
    locations: locationRows,
  };
}
