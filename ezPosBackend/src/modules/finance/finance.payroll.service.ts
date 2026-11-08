import { and, asc, count, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  employeeSalaryStructures,
  employees,
  salaryAdvances,
  type SalaryAllowance,
} from "../../db/schema/payrollFinance.js";
import { journalEntries } from "../../db/schema/journalEntries.js";
import { attendanceRecords } from "../../db/schema/attendance.js";
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
  todayForBusiness,
} from "../../services/ledger.js";
import { poishaToMoneyString, toMoneyString } from "../../utils/money.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { nextDocumentNumber } from "../../utils/documentSequence.js";
import type {
  CreateEmployeeInput,
  CreateSalaryStructureInput,
  EmployeeListQuery,
  GiveAdvanceInput,
  UpdateEmployeeInput,
} from "./finance.payroll.schema.js";

/**
 * Staff & Payroll core (Finance & Growth Stage 5): employees, salary
 * structures and salary advances.
 *
 * Treatment: an advance is an ASSET — DR 1060 / CR cash
 * (sourceType 'payroll_advance'). It is never an expense; the payroll
 * deduction in a period reduces the asset (CR 1060) while the accrual
 * expenses the full gross.
 */

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

function formatEmployeeCode(year: number, number: number): string {
  return `EMP-${year}-${String(number).padStart(6, "0")}`;
}

export async function listEmployees(businessId: number, query: EmployeeListQuery) {
  const conditions = [eq(employees.businessId, businessId)];
  if (query.status) conditions.push(eq(employees.employmentStatus, query.status));
  if (query.department) {
    conditions.push(eq(employees.department, query.department));
  }
  if (query.search) {
    const like = `%${query.search}%`;
    conditions.push(
      or(
        ilike(employees.fullName, like),
        ilike(employees.employeeCode, like),
        ilike(employees.designation, like),
      )!,
    );
  }
  const where = and(...conditions);

  const [totalRow] = await db
    .select({ value: count() })
    .from(employees)
    .where(where);
  const rows = await db
    .select({
      id: employees.id,
      employeeCode: employees.employeeCode,
      userId: employees.userId,
      fullName: employees.fullName,
      phone: employees.phone,
      email: employees.email,
      designation: employees.designation,
      department: employees.department,
      joiningDate: employees.joiningDate,
      employmentStatus: employees.employmentStatus,
      locationId: employees.locationId,
      paymentMethod: employees.paymentMethod,
      // Active structure snapshot for list views.
      payType: employeeSalaryStructures.payType,
      basicAmount: employeeSalaryStructures.basicAmount,
    })
    .from(employees)
    .leftJoin(
      employeeSalaryStructures,
      and(
        eq(employeeSalaryStructures.employeeId, employees.id),
        eq(employeeSalaryStructures.isActive, true),
      ),
    )
    .where(where)
    .orderBy(asc(employees.employeeCode))
    .limit(query.page_size)
    .offset((query.page - 1) * query.page_size);

  const total = totalRow?.value ?? 0;
  return {
    rows,
    meta: {
      page: query.page,
      pageSize: query.page_size,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.page_size)),
    },
  };
}

async function requireEmployeeInBusiness(
  tx: Tx | typeof db,
  businessId: number,
  employeeId: number,
) {
  const [employee] = await tx
    .select()
    .from(employees)
    .where(
      and(eq(employees.id, employeeId), eq(employees.businessId, businessId)),
    )
    .limit(1);
  if (!employee) throw new NotFoundError("Employee not found.");
  return employee;
}

export async function getEmployee(businessId: number, employeeId: number) {
  const employee = await requireEmployeeInBusiness(db, businessId, employeeId);
  const structures = await db
    .select()
    .from(employeeSalaryStructures)
    .where(
      and(
        eq(employeeSalaryStructures.employeeId, employeeId),
        eq(employeeSalaryStructures.businessId, businessId),
      ),
    )
    .orderBy(desc(employeeSalaryStructures.effectiveFrom));
  const [advanceTotals] = await db
    .select({
      outstanding: sql<string>`coalesce(sum(${salaryAdvances.outstandingAmount}), 0)`,
    })
    .from(salaryAdvances)
    .where(
      and(
        eq(salaryAdvances.employeeId, employeeId),
        eq(salaryAdvances.businessId, businessId),
        sql`${salaryAdvances.outstandingAmount} > 0`,
      ),
    );
  return {
    ...employee,
    structures,
    advanceOutstanding: toMoneyString(Number(advanceTotals?.outstanding ?? 0)),
  };
}

export async function createEmployee(
  businessId: number,
  input: CreateEmployeeInput,
  actorUserId: number,
) {
  if (input.userId != null) {
    const [user] = await db
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(eq(employees.businessId, businessId), eq(employees.userId, input.userId)),
      )
      .limit(1);
    if (user) {
      throw new ConflictError(
        "An employee profile already exists for this user in this business.",
      );
    }
  }
  return db.transaction(async (tx) => {
    const year = new Date().getFullYear();
    const code = formatEmployeeCode(
      year,
      await nextDocumentNumber(tx, businessId, "payroll_employee"),
    );
    const [created] = await tx
      .insert(employees)
      .values({
        businessId,
        employeeCode: code,
        userId: input.userId ?? null,
        fullName: input.fullName,
        phone: input.phone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        designation: input.designation ?? null,
        department: input.department ?? null,
        joiningDate: input.joiningDate ?? null,
        locationId: input.locationId ?? null,
        paymentMethod: input.paymentMethod ?? null,
        notes: input.notes ?? null,
        createdByUserId: actorUserId,
      })
      .returning();
    if (!created) throw new Error("Failed to create the employee.");

    if (input.salaryStructure) {
      await createSalaryStructureInTx(tx, businessId, created.id, input.salaryStructure, actorUserId);
    }

    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "payroll.employee.created",
      entityType: "employee",
      entityId: created.id,
      metadata: { code: created.employeeCode, name: created.fullName },
    });
    return created;
  });
}

export async function updateEmployee(
  businessId: number,
  employeeId: number,
  input: UpdateEmployeeInput,
  actorUserId: number,
) {
  const existing = await requireEmployeeInBusiness(db, businessId, employeeId);
  const [updated] = await db
    .update(employees)
    .set({
      fullName: input.fullName ?? existing.fullName,
      phone: input.phone !== undefined ? input.phone : existing.phone,
      email: input.email !== undefined ? input.email : existing.email,
      address: input.address !== undefined ? input.address : existing.address,
      designation: input.designation !== undefined ? input.designation : existing.designation,
      department: input.department !== undefined ? input.department : existing.department,
      joiningDate: input.joiningDate !== undefined ? input.joiningDate : existing.joiningDate,
      employmentStatus: input.employmentStatus ?? existing.employmentStatus,
      locationId: input.locationId !== undefined ? input.locationId : existing.locationId,
      paymentMethod: input.paymentMethod !== undefined ? input.paymentMethod : existing.paymentMethod,
      notes: input.notes !== undefined ? input.notes : existing.notes,
      updatedAt: new Date(),
    })
    .where(eq(employees.id, employeeId))
    .returning();
  if (!updated) throw new Error("Failed to update the employee.");
  await recordAudit({
    businessId,
    actorUserId,
    action: "payroll.employee.updated",
    entityType: "employee",
    entityId: employeeId,
    metadata: { code: existing.employeeCode },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Salary structures
// ---------------------------------------------------------------------------

async function createSalaryStructureInTx(
  tx: Tx,
  businessId: number,
  employeeId: number,
  input: CreateSalaryStructureInput,
  actorUserId: number,
) {
  const [structure] = await tx
    .insert(employeeSalaryStructures)
    .values({
      businessId,
      employeeId,
      payType: input.payType,
      basicAmount: toMoneyString(input.basicAmount),
      allowances: input.allowances.map((a) => ({
        name: a.name,
        amount: roundMoney(a.amount),
      })) satisfies SalaryAllowance[],
      overtimeRate: input.overtimeRate != null ? toMoneyString(input.overtimeRate) : null,
      effectiveFrom:
        input.effectiveFrom ?? (await todayForBusiness(tx, businessId)),
      createdByUserId: actorUserId,
    })
    .returning();
  if (!structure) throw new Error("Failed to create the salary structure.");
  return structure;
}

/** Creating a new structure retires the previous active one (versioned). */
export async function createSalaryStructure(
  businessId: number,
  employeeId: number,
  input: CreateSalaryStructureInput,
  actorUserId: number,
) {
  await requireEmployeeInBusiness(db, businessId, employeeId);
  return db.transaction(async (tx) => {
    await tx
      .update(employeeSalaryStructures)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(employeeSalaryStructures.employeeId, employeeId),
          eq(employeeSalaryStructures.businessId, businessId),
          eq(employeeSalaryStructures.isActive, true),
        ),
      );
    const structure = await createSalaryStructureInTx(
      tx,
      businessId,
      employeeId,
      input,
      actorUserId,
    );
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "payroll.structure.created",
      entityType: "employee_salary_structure",
      entityId: structure.id,
      metadata: { employeeId, payType: structure.payType },
    });
    return structure;
  });
}

// ---------------------------------------------------------------------------
// Salary advances (asset — recovered via payroll deductions FIFO)
// ---------------------------------------------------------------------------

export async function giveAdvance(
  businessId: number,
  input: GiveAdvanceInput,
  actorUserId: number | null,
) {
  return db.transaction(async (tx) => {
    if (!(await isLedgerActivatedInTx(tx, businessId))) {
      throw new ConflictError(
        "The Finance ledger is not activated for this business.",
      );
    }
    if (input.employeeId == null) {
      throw new BadRequestError("The employee is required for a salary advance.");
    }
    const employee = await requireEmployeeInBusinessTx(tx, businessId, input.employeeId);
    if (employee.employmentStatus === "terminated") {
      throw new BadRequestError("Cannot advance salary to a terminated employee.");
    }

    // Client idempotency.
    if (input.clientUuid) {
      const [existing] = await tx
        .select()
        .from(salaryAdvances)
        .where(
          and(
            eq(salaryAdvances.clientUuid, input.clientUuid),
            eq(salaryAdvances.businessId, businessId),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.employeeId !== input.employeeId) {
          throw new ConflictError(
            "This advance was already submitted for another employee.",
          );
        }
        return { advance: existing, duplicate: true as const };
      }
    }

    const amount = roundMoney(input.amount);
    const advanceDate = input.advanceDate ?? (await todayForBusiness(tx, businessId));
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

    // DR 1060 advance asset / CR cash (sourceType 'payroll_advance').
    const { entry } = await postJournalEntry(tx, {
      businessId,
      entryDate: advanceDate,
      memo: `Salary advance — ${employee.fullName}`,
      sourceType: "payroll_advance",
      cashFlowCategory: "operating",
      lines: [
        {
          accountCode: "1060",
          debit: amount,
          description: `Salary advance — ${employee.fullName}`,
        },
        {
          accountId: account.id,
          credit: amount,
          description: "Salary advance paid",
        },
      ],
      actorUserId,
    });

    const [created] = await tx
      .insert(salaryAdvances)
      .values({
        businessId,
        employeeId: employee.id,
        amount: toMoneyString(amount),
        advanceDate,
        outstandingAmount: toMoneyString(amount),
        reason: input.reason ?? null,
        journalEntryId: entry.id,
        clientUuid: input.clientUuid ?? null,
        createdByUserId: actorUserId,
      })
      .returning();
    if (!created) throw new Error("Failed to record the salary advance.");

    await tx
      .update(journalEntries)
      .set({ sourceId: created.id })
      .where(eq(journalEntries.id, entry.id));

    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "payroll.advance.given",
      entityType: "salary_advance",
      entityId: created.id,
      metadata: {
        employeeId: employee.id,
        amount: created.amount,
        entryNo: entry.entryNo,
      },
    });
    return { advance: created, duplicate: false as const };
  });
}

export async function listAdvances(businessId: number, employeeId: number) {
  return db
    .select()
    .from(salaryAdvances)
    .where(
      and(
        eq(salaryAdvances.businessId, businessId),
        eq(salaryAdvances.employeeId, employeeId),
      ),
    )
    .orderBy(desc(salaryAdvances.advanceDate), desc(salaryAdvances.id));
}

async function requireEmployeeInBusinessTx(
  tx: Tx,
  businessId: number,
  employeeId: number,
) {
  const [employee] = await tx
    .select()
    .from(employees)
    .where(
      and(eq(employees.id, employeeId), eq(employees.businessId, businessId)),
    )
    .limit(1);
  if (!employee) throw new NotFoundError("Employee not found.");
  return employee;
}

/**
 * Open advances for an employee, oldest first (FIFO recovery order).
 * Exported for the periods service.
 */
export async function openAdvancesInTx(
  tx: Tx,
  businessId: number,
  employeeId: number,
) {
  return tx
    .select()
    .from(salaryAdvances)
    .where(
      and(
        eq(salaryAdvances.businessId, businessId),
        eq(salaryAdvances.employeeId, employeeId),
        sql`${salaryAdvances.outstandingAmount} > 0`,
      ),
    )
    .orderBy(asc(salaryAdvances.advanceDate), asc(salaryAdvances.id))
    .for("update");
}

/** Attendance-derived present days for an employee's linked user. */
export async function deriveWorkedDaysFromAttendance(
  tx: Tx,
  businessId: number,
  userId: number,
  periodStart: string,
  periodEnd: string,
): Promise<number> {
  const rows = await tx
    .select({ day: sql<string>`date(${attendanceRecords.clockIn})` })
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.businessId, businessId),
        eq(attendanceRecords.userId, userId),
        gte(attendanceRecords.clockIn, new Date(`${periodStart}T00:00:00`)),
        lte(attendanceRecords.clockIn, new Date(`${periodEnd}T23:59:59.999`)),
      ),
    )
    .groupBy(sql`date(${attendanceRecords.clockIn})`);
  return rows.length;
}

export { requireEmployeeInBusinessTx };
