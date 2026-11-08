import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  employeeSalaryStructures,
  employees,
  payrollPayments,
  payrollPeriods,
  payrollRecords,
  salaryAdvances,
  type SalaryAllowance,
} from "../../db/schema/payrollFinance.js";
import { journalEntries } from "../../db/schema/journalEntries.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { recordAuditInTx, recordAudit } from "../../services/audit.js";
import type { Tx } from "../../services/audit.js";
import {
  isLedgerActivatedInTx,
  postJournalEntry,
  resolveCashAccountForMethod,
  reverseEntry,
  todayForBusiness,
} from "../../services/ledger.js";
import { poishaToMoneyString, toMoneyString } from "../../utils/money.js";
import { roundMoney } from "../../utils/roundMoney.js";
import {
  deriveWorkedDaysFromAttendance,
  openAdvancesInTx,
} from "./finance.payroll.service.js";
import type {
  CreatePayrollPeriodInput,
  PayrollRecordInput,
  SalaryPaymentInput,
  UpdatePayrollRecordInput,
} from "./finance.payroll.schema.js";

/**
 * Payroll periods: calculation, approval (accrual), payments, payslips.
 *
 * CALCULATION FORMULAS (documented per the master prompt §3.E; the record
 * stores every component so payslips reconcile):
 *   standardDays = calendar days in the period
 *   monthly:  basicPay = structure.basic
 *             attendanceDeduction = (basic / standardDays)
 *                                   × (absentDays + 0.5 × halfDays), ≤ basic
 *             basicAmount = basic − attendanceDeduction
 *   daily:    basicAmount = basic × (workedDays + 0.5 × halfDays)
 *   hourly:   basicAmount = basic × workedHours (required)
 *   allowancesTotal = Σ fixed allowances (full)
 *   overtimeAmount  = overtimeRate × overtimeHours
 *     (overtimeRate = structure.overtimeRate ?? basic / standardDays / 8 for
 *      monthly, basic / 8 for daily, basic for hourly)
 *   gross = basicAmount + allowancesTotal + overtimeAmount + bonus + commission
 *   net   = gross − otherDeductions − advanceDeduction
 *   advanceDeduction ≤ Σ open advances (validated; recovered FIFO)
 *
 * ACCRUAL (approval, sourceType 'payroll'):
 *   DR 5020 Σ gross | CR 2030 Σ (gross − advanceDeduction) | CR 1060 Σ advance
 * Other deductions are withheld inside 2030 (the employer holds them);
 * remitting them is a manual journal entry for now.
 *
 * PAYMENT (sourceType 'payroll_payment'): DR 2030 / CR cash, capped at the
 * record's net (the employee's share).
 */

function daysBetweenInclusive(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}

function lastDayOfMonth(periodStart: string): string {
  const year = Number(periodStart.slice(0, 4));
  const month = Number(periodStart.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${periodStart.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
}

interface ComputedRecord {
  employeeId: number;
  workedDays: number;
  absentDays: number;
  leaveDays: number;
  halfDays: number;
  overtimeHours: string;
  workedHours: string | null;
  basicAmount: string;
  allowancesTotal: string;
  overtimeAmount: string;
  bonusAmount: string;
  commissionAmount: string;
  otherDeductions: string;
  advanceDeduction: string;
  grossAmount: string;
  netAmount: string;
}

function computeRecord(
  structure: typeof employeeSalaryStructures.$inferSelect,
  standardDays: number,
  input: PayrollRecordInput,
  derivedWorkedDays: number | null,
): Omit<ComputedRecord, "advanceDeduction"> {
  const basic = Number(structure.basicAmount);
  const allowances = (structure.allowances as SalaryAllowance[]) ?? [];
  const allowancesTotal = allowances.reduce(
    (sum, a) => sum + roundMoney(Number(a.amount)),
    0,
  );

  const absentDays = input.absentDays ?? 0;
  const halfDays = input.halfDays ?? 0;
  const leaveDays = input.leaveDays ?? 0;
  const overtimeHours = roundMoney(input.overtimeHours ?? 0);

  let basicAmount: number;
  let workedDays: number;
  let workedHours: string | null = null;
  let overtimeRate: number;
  if (structure.payType === "monthly") {
    const attendanceDeduction = Math.min(
      roundMoney((basic / standardDays) * (absentDays + 0.5 * halfDays)),
      basic,
    );
    basicAmount = roundMoney(basic - attendanceDeduction);
    workedDays = input.workedDays ?? derivedWorkedDays ?? standardDays;
    overtimeRate =
      structure.overtimeRate != null
        ? Number(structure.overtimeRate)
        : roundMoney(basic / standardDays / 8);
  } else if (structure.payType === "daily") {
    workedDays = input.workedDays ?? derivedWorkedDays ?? 0;
    basicAmount = roundMoney(basic * (workedDays + 0.5 * halfDays));
    overtimeRate =
      structure.overtimeRate != null
        ? Number(structure.overtimeRate)
        : roundMoney(basic / 8);
  } else {
    const hours = input.workedHours;
    if (hours == null) {
      throw new BadRequestError(
        "Hourly employees need workedHours (or attendance-derived hours) on the payroll record.",
      );
    }
    workedDays = input.workedDays ?? derivedWorkedDays ?? 0;
    workedHours = hours.toFixed(2);
    basicAmount = roundMoney(basic * hours);
    overtimeRate =
      structure.overtimeRate != null ? Number(structure.overtimeRate) : basic;
  }

  const overtimeAmount = roundMoney(overtimeRate * overtimeHours);
  const bonusAmount = roundMoney(input.bonusAmount ?? 0);
  const commissionAmount = roundMoney(input.commissionAmount ?? 0);
  const grossAmount = roundMoney(
    basicAmount + allowancesTotal + overtimeAmount + bonusAmount + commissionAmount,
  );
  const otherDeductions = roundMoney(input.otherDeductions ?? 0);

  return {
    employeeId: structure.employeeId,
    workedDays,
    absentDays,
    leaveDays,
    halfDays,
    overtimeHours: overtimeHours.toFixed(2),
    workedHours,
    basicAmount: toMoneyString(basicAmount),
    allowancesTotal: toMoneyString(allowancesTotal),
    overtimeAmount: toMoneyString(overtimeAmount),
    bonusAmount: toMoneyString(bonusAmount),
    commissionAmount: toMoneyString(commissionAmount),
    otherDeductions: toMoneyString(otherDeductions),
    grossAmount: toMoneyString(grossAmount),
    netAmount: "0.00", // set after the advance deduction is applied
  };
}

/**
 * Apply an advance deduction FIFO across the employee's open advances.
 * Returns the deduction actually taken (≤ requested, ≤ total outstanding).
 */
async function applyAdvanceDeductionFifo(
  tx: Tx,
  businessId: number,
  employeeId: number,
  requested: number,
): Promise<number> {
  if (requested <= 0.005) return 0;
  const advances = await openAdvancesInTx(tx, businessId, employeeId);
  const totalOutstanding = advances.reduce(
    (sum, a) => sum + Number(a.outstandingAmount),
    0,
  );
  const deduction = Math.min(roundMoney(requested), roundMoney(totalOutstanding));
  let remaining = Math.round(deduction * 100);
  for (const advance of advances) {
    if (remaining <= 0) break;
    const outstandingPoisha = Math.round(Number(advance.outstandingAmount) * 100);
    const take = Math.min(outstandingPoisha, remaining);
    if (take <= 0) continue;
    await tx
      .update(salaryAdvances)
      .set({
        outstandingAmount: poishaToMoneyString(outstandingPoisha - take),
        updatedAt: new Date(),
      })
      .where(eq(salaryAdvances.id, advance.id));
    remaining -= take;
  }
  return deduction;
}

/** Return a previously applied deduction to the open advances (newest first). */
async function restoreAdvanceDeduction(
  tx: Tx,
  businessId: number,
  employeeId: number,
  amount: number,
): Promise<void> {
  if (amount <= 0.005) return;
  const advances = await openAdvancesInTx(tx, businessId, employeeId);
  let remaining = Math.round(roundMoney(amount) * 100);
  for (const advance of [...advances].reverse()) {
    if (remaining <= 0) break;
    const outstandingPoisha = Math.round(Number(advance.outstandingAmount) * 100);
    const capacity = Math.round(Number(advance.amount) * 100) - outstandingPoisha;
    const give = Math.min(capacity, remaining);
    if (give <= 0) continue;
    await tx
      .update(salaryAdvances)
      .set({
        outstandingAmount: poishaToMoneyString(outstandingPoisha + give),
        updatedAt: new Date(),
      })
      .where(eq(salaryAdvances.id, advance.id));
    remaining -= give;
  }
}

async function recomputePeriodTotals(tx: Tx, businessId: number, periodId: number) {
  const [totals] = await tx
    .select({
      gross: sql<string>`coalesce(sum(${payrollRecords.grossAmount}), 0)`,
      net: sql<string>`coalesce(sum(${payrollRecords.netAmount}), 0)`,
      advance: sql<string>`coalesce(sum(${payrollRecords.advanceDeduction}), 0)`,
    })
    .from(payrollRecords)
    .where(
      and(
        eq(payrollRecords.periodId, periodId),
        eq(payrollRecords.businessId, businessId),
      ),
    );
  await tx
    .update(payrollPeriods)
    .set({
      grossTotal: toMoneyString(Number(totals?.gross ?? 0)),
      netTotal: toMoneyString(Number(totals?.net ?? 0)),
      advanceRecoveryTotal: toMoneyString(Number(totals?.advance ?? 0)),
      updatedAt: new Date(),
    })
    .where(eq(payrollPeriods.id, periodId));
}

// ---------------------------------------------------------------------------
// Period lifecycle
// ---------------------------------------------------------------------------

export async function createPayrollPeriod(
  businessId: number,
  input: CreatePayrollPeriodInput,
  actorUserId: number,
) {
  return db.transaction(async (tx) => {
    if (!(await isLedgerActivatedInTx(tx, businessId))) {
      throw new ConflictError(
        "The Finance ledger is not activated for this business.",
      );
    }
    const [existing] = await tx
      .select({ id: payrollPeriods.id })
      .from(payrollPeriods)
      .where(
        and(
          eq(payrollPeriods.businessId, businessId),
          eq(payrollPeriods.periodStart, input.periodStart),
        ),
      )
      .limit(1);
    if (existing) {
      throw new ConflictError(
        `A payroll period for ${input.periodStart.slice(0, 7)} already exists.`,
      );
    }

    const periodEnd = input.periodEnd ?? lastDayOfMonth(input.periodStart);
    if (periodEnd > lastDayOfMonth(input.periodStart)) {
      throw new BadRequestError(
        "The payroll period must end within its starting month.",
      );
    }
    const standardDays = daysBetweenInclusive(input.periodStart, periodEnd);
    const inputsByEmployee = new Map<number, PayrollRecordInput>(
      input.records.map((record) => [record.employeeId, record]),
    );

    const computed: ComputedRecord[] = [];
    for (const employeeId of input.employeeIds) {
      const [employee] = await tx
        .select()
        .from(employees)
        .where(
          and(eq(employees.id, employeeId), eq(employees.businessId, businessId)),
        )
        .limit(1);
      if (!employee) throw new NotFoundError(`Employee ${employeeId} not found.`);
      if (employee.employmentStatus !== "active") {
        throw new BadRequestError(
          `${employee.fullName} is not an active employee.`,
        );
      }
      const [structure] = await tx
        .select()
        .from(employeeSalaryStructures)
        .where(
          and(
            eq(employeeSalaryStructures.employeeId, employeeId),
            eq(employeeSalaryStructures.isActive, true),
          ),
        )
        .limit(1);
      if (!structure) {
        throw new BadRequestError(
          `${employee.fullName} has no active salary structure.`,
        );
      }

      const recordInput: PayrollRecordInput = inputsByEmployee.get(employeeId) ?? {
        employeeId,
      };
      // Attendance integration: derive present days from the linked user's
      // clock-ins when the caller did not specify worked_days.
      let derivedWorkedDays: number | null = null;
      if (recordInput.workedDays == null && employee.userId != null) {
        derivedWorkedDays = await deriveWorkedDaysFromAttendance(
          tx,
          businessId,
          employee.userId,
          input.periodStart,
          periodEnd,
        );
      }
      const base = computeRecord(structure, standardDays, recordInput, derivedWorkedDays);
      const advanceDeduction = await applyAdvanceDeductionFifo(
        tx,
        businessId,
        employeeId,
        recordInput.advanceDeduction ?? 0,
      );
      const net = roundMoney(
        Number(base.grossAmount) -
          Number(base.otherDeductions) -
          advanceDeduction,
      );
      computed.push({
        ...base,
        advanceDeduction: toMoneyString(advanceDeduction),
        netAmount: toMoneyString(net),
      });
    }

    const [period] = await tx
      .insert(payrollPeriods)
      .values({
        businessId,
        periodStart: input.periodStart,
        periodEnd,
        createdByUserId: actorUserId,
      })
      .returning();
    if (!period) throw new Error("Failed to create the payroll period.");

    const records = await tx
      .insert(payrollRecords)
      .values(computed.map((record) => ({ ...record, businessId, periodId: period.id })))
      .returning();

    await recomputePeriodTotals(tx, businessId, period.id);
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "payroll.period.created",
      entityType: "payroll_period",
      entityId: period.id,
      metadata: {
        period: `${input.periodStart}..${periodEnd}`,
        employees: records.length,
      },
    });
    return { ...period, records };
  });
}

async function requirePeriodInBusiness(businessId: number, periodId: number) {
  const [period] = await db
    .select()
    .from(payrollPeriods)
    .where(
      and(eq(payrollPeriods.id, periodId), eq(payrollPeriods.businessId, businessId)),
    )
    .limit(1);
  if (!period) throw new NotFoundError("Payroll period not found.");
  return period;
}

export async function listPeriods(businessId: number) {
  return db
    .select()
    .from(payrollPeriods)
    .where(eq(payrollPeriods.businessId, businessId))
    .orderBy(desc(payrollPeriods.periodStart));
}

export async function getPeriod(businessId: number, periodId: number) {
  const period = await requirePeriodInBusiness(businessId, periodId);
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
        eq(payrollRecords.periodId, periodId),
        eq(payrollRecords.businessId, businessId),
      ),
    )
    .orderBy(asc(payrollRecords.id));
  const recordIds = records.map((r) => r.record.id);
  const payments = recordIds.length
    ? await db
        .select()
        .from(payrollPayments)
        .where(
          and(
            eq(payrollPayments.businessId, businessId),
            sql`${payrollPayments.payrollRecordId} in ${sql.raw(`(${recordIds.join(",")})`)}`,
          ),
        )
        .orderBy(asc(payrollPayments.id))
    : [];
  const paidByRecord = new Map<number, number>();
  for (const payment of payments) {
    paidByRecord.set(
      payment.payrollRecordId,
      roundMoney((paidByRecord.get(payment.payrollRecordId) ?? 0) + Number(payment.amount)),
    );
  }
  return {
    ...period,
    records: records.map((row) => ({
      ...row.record,
      employeeName: row.employeeName,
      employeeCode: row.employeeCode,
      paidAmount: toMoneyString(paidByRecord.get(row.record.id) ?? 0),
      payments: payments.filter((p) => p.payrollRecordId === row.record.id),
    })),
  };
}

/** Adjust a record's inputs on a DRAFT period and recalculate everything. */
export async function updatePayrollRecord(
  businessId: number,
  periodId: number,
  recordId: number,
  input: UpdatePayrollRecordInput,
  actorUserId: number,
) {
  return db.transaction(async (tx) => {
    const [period] = await tx
      .select()
      .from(payrollPeriods)
      .where(
        and(eq(payrollPeriods.id, periodId), eq(payrollPeriods.businessId, businessId)),
      )
      .for("update")
      .limit(1);
    if (!period) throw new NotFoundError("Payroll period not found.");
    if (period.status !== "draft") {
      throw new ConflictError(
        "Only draft periods can be adjusted. Cancel the approved period first.",
      );
    }
    const [record] = await tx
      .select()
      .from(payrollRecords)
      .where(
        and(
          eq(payrollRecords.id, recordId),
          eq(payrollRecords.periodId, periodId),
          eq(payrollRecords.businessId, businessId),
        ),
      )
      .limit(1);
    if (!record) throw new NotFoundError("Payroll record not found.");
    const [employee] = await tx
      .select()
      .from(employees)
      .where(eq(employees.id, record.employeeId))
      .limit(1);
    if (!employee) throw new Error("Payroll record employee missing.");
    const [structure] = await tx
      .select()
      .from(employeeSalaryStructures)
      .where(
        and(
          eq(employeeSalaryStructures.employeeId, employee.id),
          eq(employeeSalaryStructures.isActive, true),
        ),
      )
      .limit(1);
    if (!structure) throw new Error("Employee salary structure missing.");

    const merged: PayrollRecordInput = {
      employeeId: employee.id,
      workedDays: input.workedDays ?? record.workedDays,
      absentDays: input.absentDays ?? record.absentDays,
      leaveDays: input.leaveDays ?? record.leaveDays,
      halfDays: input.halfDays ?? record.halfDays,
      overtimeHours: input.overtimeHours ?? Number(record.overtimeHours),
      workedHours:
        input.workedHours !== undefined
          ? input.workedHours
          : record.workedHours != null
            ? Number(record.workedHours)
            : null,
      bonusAmount: input.bonusAmount ?? Number(record.bonusAmount),
      commissionAmount: input.commissionAmount ?? Number(record.commissionAmount),
      otherDeductions: input.otherDeductions ?? Number(record.otherDeductions),
      advanceDeduction: input.advanceDeduction ?? Number(record.advanceDeduction),
    };

    // Restore the previous advance allocation, then re-apply the new one.
    await restoreAdvanceDeduction(
      tx,
      businessId,
      employee.id,
      Number(record.advanceDeduction),
    );
    const advanceDeduction = await applyAdvanceDeductionFifo(
      tx,
      businessId,
      employee.id,
      merged.advanceDeduction ?? 0,
    );
    const standardDays = daysBetweenInclusive(period.periodStart, period.periodEnd);
    const base = computeRecord(structure, standardDays, merged, merged.workedDays ?? null);
    const net = roundMoney(
      Number(base.grossAmount) - Number(base.otherDeductions) - advanceDeduction,
    );

    const [updated] = await tx
      .update(payrollRecords)
      .set({
        ...base,
        advanceDeduction: toMoneyString(advanceDeduction),
        netAmount: toMoneyString(net),
        updatedAt: new Date(),
      })
      .where(eq(payrollRecords.id, recordId))
      .returning();

    await recomputePeriodTotals(tx, businessId, periodId);
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "payroll.record.updated",
      entityType: "payroll_record",
      entityId: recordId,
      metadata: { netAmount: updated?.netAmount },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Approval (accrual) / cancel / reopen
// ---------------------------------------------------------------------------

export async function approvePayrollPeriod(
  businessId: number,
  periodId: number,
  actorUserId: number,
) {
  return db.transaction(async (tx) => {
    const [period] = await tx
      .select()
      .from(payrollPeriods)
      .where(
        and(eq(payrollPeriods.id, periodId), eq(payrollPeriods.businessId, businessId)),
      )
      .for("update")
      .limit(1);
    if (!period) throw new NotFoundError("Payroll period not found.");
    if (period.status !== "draft") {
      throw new ConflictError(
        `Only draft periods can be approved (this one is ${period.status}).`,
      );
    }
    const records = await tx
      .select()
      .from(payrollRecords)
      .where(
        and(
          eq(payrollRecords.periodId, periodId),
          eq(payrollRecords.businessId, businessId),
        ),
      );
    if (records.length === 0) {
      throw new BadRequestError("The period has no payroll records to approve.");
    }
    if (!(await isLedgerActivatedInTx(tx, businessId))) {
      throw new ConflictError(
        "The Finance ledger is not activated for this business.",
      );
    }

    const grossPoisha = records.reduce((s, r) => s + Math.round(Number(r.grossAmount) * 100), 0);
    const advancePoisha = records.reduce(
      (s, r) => s + Math.round(Number(r.advanceDeduction) * 100),
      0,
    );
    const payablePoisha = grossPoisha - advancePoisha;

    // Accrual: DR 5020 gross | CR 2030 payable | CR 1060 advance recovery.
    const lines: Parameters<typeof postJournalEntry>[1]["lines"] = [
      {
        accountCode: "5020",
        debit: grossPoisha / 100,
        description: `Payroll ${period.periodStart.slice(0, 7)} (${records.length} employees)`,
      },
    ];
    if (payablePoisha > 0) {
      lines.push({
        accountCode: "2030",
        credit: payablePoisha / 100,
        description: "Salary payable (net + withheld deductions)",
      });
    }
    if (advancePoisha > 0) {
      lines.push({
        accountCode: "1060",
        credit: advancePoisha / 100,
        description: "Salary advance recovery",
      });
    }
    const { entry } = await postJournalEntry(tx, {
      businessId,
      memo: `Payroll accrual ${period.periodStart.slice(0, 7)}`,
      sourceType: "payroll",
      sourceId: period.id,
      cashFlowCategory: "operating",
      lines,
      actorUserId,
    });

    const [approved] = await tx
      .update(payrollPeriods)
      .set({
        status: "approved",
        approvedByUserId: actorUserId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(payrollPeriods.id, periodId))
      .returning();

    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "payroll.period.approved",
      entityType: "payroll_period",
      entityId: periodId,
      metadata: { entryNo: entry.entryNo, gross: approved?.grossTotal },
    });
    return approved;
  });
}

export async function cancelPayrollPeriod(
  businessId: number,
  periodId: number,
  reason: string,
  actorUserId: number,
) {
  return db.transaction(async (tx) => {
    const [period] = await tx
      .select()
      .from(payrollPeriods)
      .where(
        and(eq(payrollPeriods.id, periodId), eq(payrollPeriods.businessId, businessId)),
      )
      .for("update")
      .limit(1);
    if (!period) throw new NotFoundError("Payroll period not found.");
    if (period.status !== "approved" && period.status !== "partial") {
      throw new ConflictError(
        `Only approved periods can be cancelled (this one is ${period.status}).`,
      );
    }
    const [paymentTotals] = await tx
      .select({ value: count() })
      .from(payrollPayments)
      .innerJoin(
        payrollRecords,
        eq(payrollRecords.id, payrollPayments.payrollRecordId),
      )
      .where(
        and(
          eq(payrollRecords.periodId, periodId),
          eq(payrollPayments.businessId, businessId),
        ),
      );
    if ((paymentTotals?.value ?? 0) > 0) {
      throw new ConflictError(
        "This period has salary payments and cannot be cancelled.",
      );
    }

    // The accrual entry was posted with sourceType 'payroll',
    // sourceId = period.id — resolve it from the journal.
    const [accrual] = await tx
      .select({ id: journalEntries.id, status: journalEntries.status })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.businessId, businessId),
          eq(journalEntries.sourceType, "payroll"),
          eq(journalEntries.sourceId, periodId),
          eq(journalEntries.status, "posted"),
        ),
      )
      .limit(1);
    if (!accrual) throw new Error("Payroll accrual entry not found.");
    await reverseEntry(tx, {
      businessId,
      entryId: accrual.id,
      reason: reason || "Payroll period cancelled",
      actorUserId,
    });

    // Advance recoveries made at approval are returned to the advances.
    const records = await tx
      .select()
      .from(payrollRecords)
      .where(
        and(
          eq(payrollRecords.periodId, periodId),
          eq(payrollRecords.businessId, businessId),
        ),
      );
    for (const record of records) {
      await restoreAdvanceDeduction(
        tx,
        businessId,
        record.employeeId,
        Number(record.advanceDeduction),
      );
    }

    const [cancelled] = await tx
      .update(payrollPeriods)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(payrollPeriods.id, periodId))
      .returning();

    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "payroll.period.cancelled",
      entityType: "payroll_period",
      entityId: periodId,
      metadata: { reason },
    });
    return cancelled;
  });
}

export async function reopenPayrollPeriod(
  businessId: number,
  periodId: number,
  actorUserId: number,
) {
  const period = await requirePeriodInBusiness(businessId, periodId);
  if (period.status !== "cancelled") {
    throw new ConflictError("Only cancelled periods can be reopened.");
  }
  const [reopened] = await db
    .update(payrollPeriods)
    .set({ status: "draft", approvedByUserId: null, approvedAt: null, updatedAt: new Date() })
    .where(eq(payrollPeriods.id, periodId))
    .returning();
  await recordAudit({
    businessId,
    actorUserId,
    action: "payroll.period.reopened",
    entityType: "payroll_period",
    entityId: periodId,
  });
  return reopened;
}

// ---------------------------------------------------------------------------
// Salary payments
// ---------------------------------------------------------------------------

export async function recordSalaryPayment(
  businessId: number,
  recordId: number,
  input: SalaryPaymentInput,
  actorUserId: number | null,
) {
  return db.transaction(async (tx) => {
    const [record] = await tx
      .select()
      .from(payrollRecords)
      .where(
        and(
          eq(payrollRecords.id, recordId),
          eq(payrollRecords.businessId, businessId),
        ),
      )
      .for("update")
      .limit(1);
    if (!record) throw new NotFoundError("Payroll record not found.");
    const [period] = await tx
      .select()
      .from(payrollPeriods)
      .where(eq(payrollPeriods.id, record.periodId))
      .limit(1);
    if (!period || (period.status !== "approved" && period.status !== "partial" && period.status !== "paid")) {
      throw new ConflictError("Salaries can only be paid for approved periods.");
    }

    // Client idempotency.
    if (input.clientUuid) {
      const [existing] = await tx
        .select()
        .from(payrollPayments)
        .where(
          and(
            eq(payrollPayments.clientUuid, input.clientUuid),
            eq(payrollPayments.businessId, businessId),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.payrollRecordId !== recordId) {
          throw new ConflictError(
            "This payment was already submitted for another record.",
          );
        }
        return { payment: existing, duplicate: true as const };
      }
    }

    const [paidTotals] = await tx
      .select({ paid: sql<string>`coalesce(sum(${payrollPayments.amount}), 0)` })
      .from(payrollPayments)
      .where(eq(payrollPayments.payrollRecordId, recordId));
    const paid = roundMoney(Number(paidTotals?.paid ?? 0));
    const net = roundMoney(Number(record.netAmount));
    const remaining = roundMoney(net - paid);
    if (remaining <= 0.005) {
      throw new BadRequestError("This salary is already fully paid.");
    }
    const amount = roundMoney(input.amount);
    if (amount > remaining) {
      throw new BadRequestError(
        `Payment of ${amount.toFixed(2)} exceeds the remaining salary of ${remaining.toFixed(2)}.`,
      );
    }

    const paymentDate = input.paymentDate ?? (await todayForBusiness(tx, businessId));
    const { account, paymentAccountId } = await resolveCashAccountForMethod(
      tx,
      businessId,
      input.method ?? "cash",
      { paymentAccountId: input.paymentAccountId ?? null },
    );
    if (
      input.paymentAccountId != null &&
      paymentAccountId !== input.paymentAccountId
    ) {
      throw new NotFoundError("Payment account not found for this business.");
    }

    // DR 2030 / CR cash (sourceType 'payroll_payment').
    const { entry } = await postJournalEntry(tx, {
      businessId,
      entryDate: paymentDate,
      memo: `Salary payment — record ${recordId}`,
      sourceType: "payroll_payment",
      sourceId: null, // set after insert (see below)
      cashFlowCategory: "operating",
      lines: [
        {
          accountCode: "2030",
          debit: amount,
          description: "Salary payable settled",
        },
        {
          accountId: account.id,
          credit: amount,
          description: `Salary payment (${input.method ?? "cash"})`,
        },
      ],
      actorUserId,
    });

    const [created] = await tx
      .insert(payrollPayments)
      .values({
        businessId,
        payrollRecordId: recordId,
        amount: toMoneyString(amount),
        method: input.method ?? null,
        paymentAccountId,
        paymentDate,
        reference: input.reference ?? null,
        journalEntryId: entry.id,
        clientUuid: input.clientUuid ?? null,
        createdByUserId: actorUserId,
      })
      .returning();
    if (!created) throw new Error("Failed to record the salary payment.");

    await tx
      .update(journalEntries)
      .set({ sourceId: created.id })
      .where(eq(journalEntries.id, entry.id));

    // Period status: paid when every record is fully settled, partial when
    // any payment exists, else approved.
    await refreshPeriodPaymentStatus(tx, businessId, record.periodId);

    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "payroll.payment.recorded",
      entityType: "payroll_payment",
      entityId: created.id,
      metadata: {
        recordId,
        amount: created.amount,
        entryNo: entry.entryNo,
      },
    });
    return { payment: created, duplicate: false as const };
  });
}

async function refreshPeriodPaymentStatus(tx: Tx, businessId: number, periodId: number) {
  const [totals] = await tx
    .select({
      records: count(),
      net: sql<string>`coalesce(sum(${payrollRecords.netAmount}), 0)`,
      paid: sql<string>`coalesce(sum((select coalesce(sum(p.amount), 0) from payroll_payments p where p.payroll_record_id = ${payrollRecords.id})), 0)`,
    })
    .from(payrollRecords)
    .where(
      and(
        eq(payrollRecords.periodId, periodId),
        eq(payrollRecords.businessId, businessId),
      ),
    );
  const net = roundMoney(Number(totals?.net ?? 0));
  const paid = roundMoney(Number(totals?.paid ?? 0));
  const status =
    paid <= 0.005 ? "approved" : paid + 0.005 >= net ? "paid" : "partial";
  await tx
    .update(payrollPeriods)
    .set({ status, updatedAt: new Date() })
    .where(eq(payrollPeriods.id, periodId));
}

export async function voidSalaryPayment(
  businessId: number,
  paymentId: number,
  actorUserId: number,
) {
  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payrollPayments)
      .where(
        and(
          eq(payrollPayments.id, paymentId),
          eq(payrollPayments.businessId, businessId),
        ),
      )
      .limit(1);
    if (!payment) throw new NotFoundError("Salary payment not found.");

    // Reverse the posted entry, then remove the operational row.
    const { journalEntries } = await import("../../db/schema/journalEntries.js");
    const [posted] = await tx
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.businessId, businessId),
          eq(journalEntries.sourceType, "payroll_payment"),
          eq(journalEntries.sourceId, paymentId),
          eq(journalEntries.status, "posted"),
        ),
      )
      .limit(1);
    if (posted) {
      await reverseEntry(tx, {
        businessId,
        entryId: posted.id,
        reason: "Salary payment voided",
        actorUserId,
      });
    }
    await tx.delete(payrollPayments).where(eq(payrollPayments.id, paymentId));

    await refreshPeriodPaymentStatus(tx, businessId, (
      await tx
        .select({ periodId: payrollRecords.periodId })
        .from(payrollRecords)
        .where(eq(payrollRecords.id, payment.payrollRecordId))
        .limit(1)
    )[0]!.periodId);

    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "payroll.payment.void",
      entityType: "payroll_payment",
      entityId: paymentId,
      metadata: { amount: payment.amount },
    });
    return { voided: true };
  });
}

// ---------------------------------------------------------------------------
// Payslip
// ---------------------------------------------------------------------------

export async function getPayslip(businessId: number, recordId: number) {
  const [row] = await db
    .select({
      record: payrollRecords,
      employee: employees,
      period: payrollPeriods,
    })
    .from(payrollRecords)
    .innerJoin(employees, eq(employees.id, payrollRecords.employeeId))
    .innerJoin(payrollPeriods, eq(payrollPeriods.id, payrollRecords.periodId))
    .where(
      and(
        eq(payrollRecords.id, recordId),
        eq(payrollRecords.businessId, businessId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Payroll record not found.");

  const payments = await db
    .select()
    .from(payrollPayments)
    .where(eq(payrollPayments.payrollRecordId, recordId))
    .orderBy(asc(payrollPayments.id));
  const paid = roundMoney(
    payments.reduce((sum, p) => sum + Number(p.amount), 0),
  );
  const net = roundMoney(Number(row.record.netAmount));
  const paymentStatus =
    paid <= 0.005 ? "unpaid" : paid + 0.005 >= net ? "paid" : "partial";

  return {
    period: {
      id: row.period.id,
      periodStart: row.period.periodStart,
      periodEnd: row.period.periodEnd,
      status: row.period.status,
    },
    employee: {
      id: row.employee.id,
      employeeCode: row.employee.employeeCode,
      fullName: row.employee.fullName,
      designation: row.employee.designation,
      department: row.employee.department,
      joiningDate: row.employee.joiningDate,
    },
    earnings: {
      workedDays: row.record.workedDays,
      absentDays: row.record.absentDays,
      leaveDays: row.record.leaveDays,
      halfDays: row.record.halfDays,
      overtimeHours: row.record.overtimeHours,
      basicAmount: row.record.basicAmount,
      allowancesTotal: row.record.allowancesTotal,
      overtimeAmount: row.record.overtimeAmount,
      bonusAmount: row.record.bonusAmount,
      commissionAmount: row.record.commissionAmount,
      grossAmount: row.record.grossAmount,
    },
    deductions: {
      otherDeductions: row.record.otherDeductions,
      advanceDeduction: row.record.advanceDeduction,
    },
    netAmount: row.record.netAmount,
    paidAmount: toMoneyString(paid),
    paymentStatus,
    payments,
  };
}
