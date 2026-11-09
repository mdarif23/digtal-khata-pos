import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { auditLog } from "../../db/schema/auditLog.js";
import { capitalTransactions } from "../../db/schema/ownerFinance.js";
import { ownerProfiles } from "../../db/schema/ownerFinance.js";
import {
  employees,
  payrollPayments,
  payrollPeriods,
  payrollRecords,
} from "../../db/schema/payrollFinance.js";
import { profitAllocationLines, profitAllocations } from "../../db/schema/ownerFinance.js";
import {
  journalEntries,
  journalEntryLines,
} from "../../db/schema/journalEntries.js";
import { chartOfAccounts } from "../../db/schema/chartOfAccounts.js";
import { purchases } from "../../db/schema/purchases.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { sales } from "../../db/schema/sales.js";
import { poishaToMoneyString } from "../../utils/money.js";
import { getAccountBalances } from "../../services/ledger.js";
import { calculateProfit } from "./finance.profit.service.js";
import { listLoans } from "./finance.tools.service.js";

/**
 * Financial reports (Finance & Growth Stage 8 / Phase 8). Each report is a
 * thin, documented composition over the GL and the operational ledgers it
 * reconciles against. Tabular reports expose column metadata so the
 * controller can serialize CSV (`format=csv`) without knowing the shape.
 */

function poisha(balance: string | undefined): number {
  return Math.round(Number(balance ?? 0) * 100);
}

function money(poishaValue: number): string {
  return poishaToMoneyString(poishaValue);
}

function prevDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export interface ReportTable<T> {
  columns: { key: string; label: string }[];
  rows: T[];
  totals?: Record<string, string | number | null>;
}

// ---------------------------------------------------------------------------
// 1. Profit & Loss statement
// ---------------------------------------------------------------------------

export async function getProfitAndLoss(businessId: number, from: string, to: string) {
  const [profit, balances] = await Promise.all([
    calculateProfit(businessId, from, to),
    getAccountBalances(db, businessId, { fromDate: from, toDate: to }),
  ]);
  const revenueLines = balances
    .filter((b) => b.type === "revenue")
    .map((b) => ({ code: b.code, name: b.name, balance: poishaToMoneyString(-poisha(b.balance)) }));
  const expenseLines = balances
    .filter((b) => b.type === "expense" && b.code !== "5010" && b.code !== "5090")
    .map((b) => ({ code: b.code, name: b.name, balance: b.balance }));

  return {
    range: { from, to },
    revenue: {
      lines: revenueLines,
      net: profit.netRevenue,
    },
    cogs: profit.cogs,
    grossProfit: profit.grossProfit,
    operatingExpenses: {
      lines: expenseLines,
      total: profit.operatingExpenses,
    },
    operatingProfit: profit.operatingProfit,
    interest: profit.interest,
    netProfit: profit.netProfit,
  };
}

// ---------------------------------------------------------------------------
// 4/5. Owner investment & withdrawal reports
// ---------------------------------------------------------------------------

export async function getOwnerCapitalReport(
  businessId: number,
  from: string,
  to: string,
  type: "investment" | "withdrawal",
) {
  const rows = await db
    .select({
      id: capitalTransactions.id,
      txnDate: capitalTransactions.txnDate,
      ownerName: ownerProfiles.name,
      amount: capitalTransactions.amount,
      method: capitalTransactions.method,
      sourceOfFunds: capitalTransactions.sourceOfFunds,
      reference: capitalTransactions.reference,
      description: capitalTransactions.description,
    })
    .from(capitalTransactions)
    .innerJoin(
      ownerProfiles,
      eq(ownerProfiles.id, capitalTransactions.ownerProfileId),
    )
    .where(
      and(
        eq(capitalTransactions.businessId, businessId),
        eq(capitalTransactions.type, type),
        gte(capitalTransactions.txnDate, from),
        lte(capitalTransactions.txnDate, to),
      ),
    )
    .orderBy(asc(capitalTransactions.txnDate), asc(capitalTransactions.id));

  const totalPoisha = rows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0);
  const columns = [
    { key: "txnDate", label: "Date" },
    { key: "ownerName", label: "Owner" },
    { key: "amount", label: "Amount" },
    { key: "method", label: "Method" },
    ...(type === "investment"
      ? [{ key: "sourceOfFunds", label: "Source of funds" }]
      : []),
    { key: "reference", label: "Reference" },
    { key: "description", label: "Description" },
  ];
  return {
    range: { from, to },
    type,
    rows,
    total: money(totalPoisha),
    columns,
  } satisfies ReportTable<(typeof rows)[number]> & {
    range: { from: string; to: string };
    type: string;
    total: string;
  };
}

// ---------------------------------------------------------------------------
// 6. Profit allocation report
// ---------------------------------------------------------------------------

export async function getAllocationReport(businessId: number, from: string, to: string) {
  // The reports page builds its table from `columns` — omitting them renders
  // a zero-column table (every other tabular report ships its columns).
  const columns = [
    { key: "periodStart", label: "Period start" },
    { key: "periodEnd", label: "Period end" },
    { key: "periodLabel", label: "Label" },
    { key: "totalAllocated", label: "Allocated" },
    { key: "status", label: "Status" },
  ];
  const allocations = await db
    .select()
    .from(profitAllocations)
    .where(
      and(
        eq(profitAllocations.businessId, businessId),
        gte(profitAllocations.periodEnd, from),
        lte(profitAllocations.periodStart, to),
      ),
    )
    .orderBy(desc(profitAllocations.periodStart));
  if (allocations.length === 0) {
    return { range: { from, to }, rows: [], columns, totalAllocated: "0.00", totalRealized: "0.00" };
  }
  const lines = await db
    .select()
    .from(profitAllocationLines)
    .where(
      and(
        eq(profitAllocationLines.businessId, businessId),
        sql`${profitAllocationLines.allocationId} in ${sql.raw(`(${allocations.map((a) => a.id).join(",")})`)}`,
      ),
    );
  const totalAllocatedPoisha = allocations.reduce(
    (s, a) => s + Math.round(Number(a.totalAllocated) * 100),
    0,
  );
  const totalRealizedPoisha = lines.reduce(
    (s, l) => s + Math.round(Number(l.realizedAmount) * 100),
    0,
  );
  return {
    range: { from, to },
    rows: allocations.map((allocation) => ({
      ...allocation,
      lines: lines.filter((l) => l.allocationId === allocation.id),
    })),
    columns,
    totalAllocated: money(totalAllocatedPoisha),
    totalRealized: money(totalRealizedPoisha),
  };
}

// ---------------------------------------------------------------------------
// 7. Retained earnings rollforward
// ---------------------------------------------------------------------------

export async function getRetainedEarningsReport(
  businessId: number,
  from: string,
  to: string,
) {
  // Opening retained position = 3030 balance + cumulative net profit earned
  // BEFORE the range (revenue/expense accounts are still open on the books).
  const [openingBalances, profit, distributionsRow] = await Promise.all([
    getAccountBalances(db, businessId, { toDate: prevDay(from) }),
    calculateProfit(businessId, from, to),
    db
      .select({
        total: sql<string>`coalesce(sum(${capitalTransactions.amount}) filter (where ${capitalTransactions.type} = 'distribution'), 0)`,
      })
      .from(capitalTransactions)
      .where(
        and(
          eq(capitalTransactions.businessId, businessId),
          eq(capitalTransactions.type, "distribution"),
          gte(capitalTransactions.txnDate, from),
          lte(capitalTransactions.txnDate, to),
        ),
      ),
  ]);
  const byCode = new Map(openingBalances.map((b) => [b.code, b]));
  const openingRetainedPoisha =
    -poisha(byCode.get("3030")?.balance) +
    openingBalances
      .filter((b) => b.type === "revenue")
      .reduce((s, b) => s - poisha(b.balance), 0) -
    openingBalances
      .filter((b) => b.type === "expense")
      .reduce((s, b) => s + poisha(b.balance), 0);
  const netProfitPoisha = poisha(profit.netProfit);
  const distributionsPoisha = poisha(distributionsRow[0]?.total);

  return {
    range: { from, to },
    openingRetainedEarnings: money(openingRetainedPoisha),
    netProfit: profit.netProfit,
    lessProfitDistributions: money(distributionsPoisha),
    closingRetainedEarnings: money(
      openingRetainedPoisha + netProfitPoisha - distributionsPoisha,
    ),
    note:
      "Owner withdrawals (capital repayment) reduce equity via the drawings account, not retained earnings.",
  };
}

// ---------------------------------------------------------------------------
// 8/9. Payroll & salary outstanding reports
// ---------------------------------------------------------------------------

export async function getPayrollReport(businessId: number, from: string, to: string) {
  const periods = await db
    .select()
    .from(payrollPeriods)
    .where(
      and(
        eq(payrollPeriods.businessId, businessId),
        gte(payrollPeriods.periodStart, from),
        lte(payrollPeriods.periodStart, to),
      ),
    )
    .orderBy(desc(payrollPeriods.periodStart));
  if (periods.length === 0) {
    return {
      range: { from, to },
      rows: [],
      columns: [
        { key: "period", label: "Period" },
        { key: "status", label: "Status" },
        { key: "employeeName", label: "Employee" },
        { key: "grossAmount", label: "Gross" },
        { key: "deductions", label: "Deductions" },
        { key: "netAmount", label: "Net" },
        { key: "paidAmount", label: "Paid" },
      ],
      totals: { grossAmount: "0.00", netAmount: "0.00" },
    };
  }
  const periodIds = periods.map((p) => p.id);
  const records = await db
    .select({
      record: payrollRecords,
      employeeName: employees.fullName,
      employeeCode: employees.employeeCode,
    })
    .from(payrollRecords)
    .innerJoin(employees, eq(employees.id, payrollRecords.employeeId))
    .where(
      and(
        eq(payrollRecords.businessId, businessId),
        sql`${payrollRecords.periodId} in ${sql.raw(`(${periodIds.join(",")})`)}`,
      ),
    )
    .orderBy(asc(payrollRecords.id));
  const payments = await db
    .select({
      recordId: payrollPayments.payrollRecordId,
      paid: sql<string>`coalesce(sum(${payrollPayments.amount}), 0)`,
    })
    .from(payrollPayments)
    .where(eq(payrollPayments.businessId, businessId))
    .groupBy(payrollPayments.payrollRecordId);
  const paidByRecord = new Map(payments.map((p) => [p.recordId, Number(p.paid)]));

  const rows = records.map((row) => {
    const deductions = round2(
      Number(row.record.otherDeductions) + Number(row.record.advanceDeduction),
    );
    return {
      period: `${row.record.createdAt}`,
      periodStart: periods.find((p) => p.id === row.record.periodId)?.periodStart,
      status: periods.find((p) => p.id === row.record.periodId)?.status,
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      grossAmount: row.record.grossAmount,
      deductions: deductions.toFixed(2),
      netAmount: row.record.netAmount,
      paidAmount: (paidByRecord.get(row.record.id) ?? 0).toFixed(2),
    };
  });
  const grossPoisha = rows.reduce((s, r) => s + Math.round(Number(r.grossAmount) * 100), 0);
  const netPoisha = rows.reduce((s, r) => s + Math.round(Number(r.netAmount) * 100), 0);

  return {
    range: { from, to },
    rows,
    columns: [
      { key: "periodStart", label: "Period" },
      { key: "status", label: "Status" },
      { key: "employeeCode", label: "Code" },
      { key: "employeeName", label: "Employee" },
      { key: "grossAmount", label: "Gross" },
      { key: "deductions", label: "Deductions" },
      { key: "netAmount", label: "Net" },
      { key: "paidAmount", label: "Paid" },
    ],
    totals: { grossAmount: money(grossPoisha), netAmount: money(netPoisha) },
  };
}

export async function getSalaryOutstandingReport(businessId: number) {
  // Approved (or later) periods only — drafts and cancellations owe nothing.
  const rows = await db.execute(sql`
    SELECT
      e.id AS "employeeId",
      e.employee_code AS "employeeCode",
      e.full_name AS "employeeName",
      round(coalesce(sum(r.net_amount), 0)::numeric, 2)::float8 AS "earned",
      round(coalesce(pay.paid, 0)::numeric, 2)::float8 AS "paid"
    FROM payroll_records r
    JOIN payroll_periods per ON per.id = r.period_id AND per.business_id = r.business_id
    JOIN employees e ON e.id = r.employee_id
    LEFT JOIN (
      SELECT payroll_record_id, sum(amount) AS paid
      FROM payroll_payments GROUP BY payroll_record_id
    ) pay ON pay.payroll_record_id = r.id
    WHERE r.business_id = ${businessId}
      AND per.status IN ('approved', 'partial', 'paid')
    GROUP BY e.id, e.employee_code, e.full_name, pay.paid
    HAVING coalesce(sum(r.net_amount), 0) - coalesce(pay.paid, 0) > 0.005
    ORDER BY e.full_name
  `);
  const mapped = rows.rows.map((row) => {
    const r = row as Record<string, unknown>;
    const earned = Number(r.earned ?? 0);
    const paid = Number(r.paid ?? 0);
    return {
      employeeId: Number(r.employeeId),
      employeeCode: String(r.employeeCode ?? ""),
      employeeName: String(r.employeeName ?? ""),
      earned: earned.toFixed(2),
      paid: paid.toFixed(2),
      outstanding: (earned - paid).toFixed(2),
    };
  });
  const outstandingPoisha = mapped.reduce(
    (s, r) => s + Math.round(Number(r.outstanding) * 100),
    0,
  );
  return {
    rows: mapped,
    totalOutstanding: money(outstandingPoisha),
    columns: [
      { key: "employeeCode", label: "Code" },
      { key: "employeeName", label: "Employee" },
      { key: "earned", label: "Earned" },
      { key: "paid", label: "Paid" },
      { key: "outstanding", label: "Outstanding" },
    ],
  };
}

// ---------------------------------------------------------------------------
// 10. Loan outstanding report
// ---------------------------------------------------------------------------

export async function getLoanOutstandingReport(businessId: number) {
  const loans = await listLoans(businessId);
  const active = loans.filter((loan) => loan.status === "active");
  const outstandingPoisha = active.reduce(
    (s, loan) => s + Math.round(Number(loan.outstanding) * 100),
    0,
  );
  return {
    rows: loans,
    totalOutstanding: money(outstandingPoisha),
    columns: [
      { key: "lenderName", label: "Lender" },
      { key: "principal", label: "Principal" },
      { key: "principalRepaid", label: "Repaid" },
      { key: "interestPaid", label: "Interest paid" },
      { key: "outstanding", label: "Outstanding" },
      { key: "status", label: "Status" },
    ],
  };
}

// ---------------------------------------------------------------------------
// 11. Budget variance report
// ---------------------------------------------------------------------------

export async function getBudgetVarianceReport(
  businessId: number,
  from: string,
  to: string,
) {
  const rows = await db.execute(sql`
    SELECT
      b.id,
      b.period_type AS "periodType",
      b.month,
      ec.category_name AS "categoryName",
      l.name AS "locationName",
      b.amount,
      round(coalesce(sum(e.amount), 0)::numeric, 2)::float8 AS "actualAmount",
      b.warning_threshold_percent AS "warningThresholdPercent"
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
    LEFT JOIN expense_categories ec ON ec.id = b.category_id
    LEFT JOIN locations l ON l.id = b.location_id
    WHERE b.business_id = ${businessId}
      AND b.month <= ${to}::date
      AND (b.month + (CASE b.period_type WHEN 'quarterly' THEN interval '3 months' WHEN 'yearly' THEN interval '1 year' ELSE interval '1 month' END)) > ${from}::date
    GROUP BY b.id, ec.category_name, l.name
    ORDER BY b.month DESC, b.amount DESC
  `);
  const mapped = rows.rows.map((row) => {
    const r = row as Record<string, unknown>;
    const amount = Number(r.amount ?? 0);
    const actualAmount = Number(r.actualAmount ?? 0);
    return {
      id: Number(r.id),
      periodType: String(r.periodType ?? "monthly"),
      month: String(r.month ?? ""),
      categoryName: (r.categoryName as string | null) ?? null,
      locationName: (r.locationName as string | null) ?? null,
      budget: amount.toFixed(2),
      actual: actualAmount.toFixed(2),
      variance: (amount - actualAmount).toFixed(2),
      utilizationPercent:
        amount > 0 ? Math.round((actualAmount / amount) * 10000) / 100 : null,
      overBudget: actualAmount > amount,
    };
  });
  const budgetPoisha = mapped.reduce((s, r) => s + Math.round(Number(r.budget) * 100), 0);
  const actualPoisha = mapped.reduce((s, r) => s + Math.round(Number(r.actual) * 100), 0);
  return {
    range: { from, to },
    rows: mapped,
    totals: { budget: money(budgetPoisha), actual: money(actualPoisha) },
    columns: [
      { key: "month", label: "Period" },
      { key: "periodType", label: "Type" },
      { key: "categoryName", label: "Category" },
      { key: "locationName", label: "Location" },
      { key: "budget", label: "Budget" },
      { key: "actual", label: "Actual" },
      { key: "variance", label: "Variance" },
      { key: "overBudget", label: "Over budget" },
    ],
  };
}

// ---------------------------------------------------------------------------
// 13. Financial transaction report
// ---------------------------------------------------------------------------

export async function getTransactionReport(
  businessId: number,
  from: string,
  to: string,
  sourceType?: string,
) {
  const conditions = [
    eq(journalEntries.businessId, businessId),
    gte(journalEntries.entryDate, from),
    lte(journalEntries.entryDate, to),
    sql`${journalEntries.status} in ('posted', 'reversed')`,
  ];
  if (sourceType) conditions.push(eq(journalEntries.sourceType, sourceType));
  const entries = await db
    .select({
      id: journalEntries.id,
      entryNo: journalEntries.entryNo,
      entryDate: journalEntries.entryDate,
      memo: journalEntries.memo,
      sourceType: journalEntries.sourceType,
      cashFlowCategory: journalEntries.cashFlowCategory,
      status: journalEntries.status,
    })
    .from(journalEntries)
    .where(and(...conditions))
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.id))
    .limit(1000);
  const entryIds = entries.map((e) => e.id);
  const lines = entryIds.length
    ? await db
        .select({
          entryId: journalEntryLines.entryId,
          accountCode: chartOfAccounts.code,
          accountName: chartOfAccounts.name,
          debit: journalEntryLines.debit,
          credit: journalEntryLines.credit,
          description: journalEntryLines.description,
        })
        .from(journalEntryLines)
        .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
        .where(sql`${journalEntryLines.entryId} in ${sql.raw(`(${entryIds.join(",")})`)}`)
        .orderBy(asc(journalEntryLines.id))
    : [];
  const totalDebitPoisha = lines.reduce((s, l) => s + Math.round(Number(l.debit) * 100), 0);
  const totalCreditPoisha = lines.reduce((s, l) => s + Math.round(Number(l.credit) * 100), 0);

  return {
    range: { from, to },
    rows: entries.map((entry) => ({
      ...entry,
      lines: lines.filter((l) => l.entryId === entry.id),
    })),
    totalDebit: money(totalDebitPoisha),
    totalCredit: money(totalCreditPoisha),
    balanced: totalDebitPoisha === totalCreditPoisha,
    truncated: entries.length >= 1000,
    columns: [
      { key: "entryDate", label: "Date" },
      { key: "entryNo", label: "Entry" },
      { key: "sourceType", label: "Source" },
      { key: "accountCode", label: "Account" },
      { key: "debit", label: "Debit" },
      { key: "credit", label: "Credit" },
      { key: "memo", label: "Memo" },
    ],
  };
}

// ---------------------------------------------------------------------------
// Reconciliation (Phase 4.D) — GL vs operational truths
// ---------------------------------------------------------------------------

export interface ReconciliationCheck {
  key: string;
  glAccount: string;
  glBalance: string;
  operational: string;
  variance: string;
  reconciled: boolean;
}

export async function getReconciliation(businessId: number) {
  const balances = await getAccountBalances(db, businessId, {});
  const byCode = new Map(balances.map((b) => [b.code, b]));

  const [batchValuation] = await db
    .select({
      total: sql<string>`coalesce(sum(${inventoryBatches.quantityRemaining} * ${inventoryBatches.landedCostPerUnit}), 0)`,
    })
    .from(inventoryBatches)
    .where(eq(inventoryBatches.businessId, businessId));

  // Derived receivables: completed sales still owed (due_amount is the
  // maintained mirror of final_total − payments − refunds).
  const [receivables] = await db
    .select({
      total: sql<string>`coalesce(sum(${sales.dueAmount}), 0)`,
    })
    .from(sales)
    .where(
      and(
        eq(sales.businessId, businessId),
        eq(sales.status, "completed"),
        sql`${sales.paymentStatus} in ('unpaid', 'partial')`,
      ),
    );

  // Derived payables: purchases still owed (due_amount maintained mirror),
  // minus returned/credited value already relieved through returns.
  const [payables] = await db
    .select({
      due: sql<string>`coalesce(sum(${purchases.dueAmount}), 0)`,
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.businessId, businessId),
        sql`${purchases.paymentStatus} in ('unpaid', 'partial')`,
      ),
    );

  // Salary payable: net + withheld of approved periods − payments made.
  const [salaryPayable] = await db.execute(sql`
    SELECT coalesce(sum(r.net_amount + r.other_deductions - coalesce(pay.paid, 0)), 0)::float8 AS total
    FROM payroll_records r
    JOIN payroll_periods per ON per.id = r.period_id AND per.business_id = r.business_id
    LEFT JOIN (SELECT payroll_record_id, sum(amount) AS paid FROM payroll_payments GROUP BY payroll_record_id) pay
      ON pay.payroll_record_id = r.id
    WHERE r.business_id = ${businessId} AND per.status IN ('approved', 'partial', 'paid')
  `).then((r) => r.rows as { total: number }[]);

  const checks: ReconciliationCheck[] = [
    {
      key: "inventory",
      glAccount: "1050",
      glBalance: byCode.get("1050")?.balance ?? "0.00",
      operational: Number(batchValuation?.total ?? 0).toFixed(2),
    },
    {
      key: "receivables",
      glAccount: "1040",
      glBalance: byCode.get("1040")?.balance ?? "0.00",
      operational: Number(receivables?.total ?? 0).toFixed(2),
    },
    {
      key: "payables",
      glAccount: "2010",
      glBalance: poishaToMoneyString(-poisha(byCode.get("2010")?.balance)),
      operational: Number(payables?.due ?? 0).toFixed(2),
    },
    {
      key: "salaryPayable",
      glAccount: "2030",
      glBalance: poishaToMoneyString(-poisha(byCode.get("2030")?.balance)),
      operational: Number(salaryPayable?.total ?? 0).toFixed(2),
    },
  ].map((check) => {
    const variance =
      Math.round(Number(check.glBalance) * 100) -
      Math.round(Number(check.operational) * 100);
    return {
      ...check,
      variance: money(variance),
      reconciled: Math.abs(variance) <= 0,
    };
  });

  return {
    checks,
    allReconciled: checks.every((c) => c.reconciled),
    note:
      "Variances are corrected with manual journal entries (sourceType 'adjustment'); posted entries are immutable, so corrections are always reversals + replacements.",
  };
}

// ---------------------------------------------------------------------------
// Audit trail view (Phase 8.C) — the audit_log was write-only until now.
// ---------------------------------------------------------------------------

export async function listAuditTrail(
  businessId: number,
  filters: {
    action?: string;
    entityType?: string;
    entityId?: number;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  },
) {
  const conditions = [eq(auditLog.businessId, businessId)];
  if (filters.action) conditions.push(eq(auditLog.action, filters.action));
  if (filters.entityType) {
    conditions.push(eq(auditLog.entityType, filters.entityType));
  }
  if (filters.entityId != null) {
    conditions.push(eq(auditLog.entityId, filters.entityId));
  }
  if (filters.from) {
    conditions.push(gte(auditLog.createdAt, new Date(`${filters.from}T00:00:00`)));
  }
  if (filters.to) {
    conditions.push(lte(auditLog.createdAt, new Date(`${filters.to}T23:59:59.999`)));
  }
  const where = and(...conditions);
  const [totalRow] = await db
    .select({ value: sql<string>`count(*)` })
    .from(auditLog)
    .where(where);
  const rows = await db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.createdAt))
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);
  const total = Number(totalRow?.value ?? 0);
  return {
    rows,
    meta: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
    },
  };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
