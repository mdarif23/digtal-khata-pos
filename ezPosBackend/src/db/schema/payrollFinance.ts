import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { users } from "./users.js";
import { locations } from "./locations.js";
import { paymentAccounts } from "./paymentAccounts.js";

/**
 * Staff & Payroll (Finance & Growth Stage 5, approved architecture §8).
 *
 * GL treatment (posting hooks, sourceTypes 'payroll' | 'payroll_advance' |
 * 'payroll_payment'):
 *   accrual (period approval)  DR 5020 Salaries & Wages (gross)
 *                              CR 2030 Salary Payable (net + withheld)
 *                              CR 1060 Employee Salary Advances (recovery)
 *   advance given              DR 1060 / CR cash
 *   salary payment             DR 2030 / CR cash
 * An advance is an ASSET (the employee owes the business) — it is never an
 * expense and never double-counted: the payroll deduction reduces the
 * advance asset while the accrual expenses the full gross.
 */

export const employeeStatusEnum = pgEnum("employee_status", [
  "active",
  "inactive",
  "terminated",
]);

export const salaryPayTypeEnum = pgEnum("salary_pay_type", [
  "monthly",
  "daily",
  "hourly",
]);

export const payrollPeriodStatusEnum = pgEnum("payroll_period_status", [
  "draft",
  "approved",
  "paid",
  "partial",
  "cancelled",
]);

export const employees = pgTable(
  "employees",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    /** EMP-YYYY-000001 via document_sequences key "payroll_employee". */
    employeeCode: varchar("employee_code", { length: 30 }).notNull(),
    /** Attendance derivation links through the platform user. */
    userId: integer("user_id").references(() => users.id),
    fullName: varchar("full_name", { length: 120 }).notNull(),
    phone: varchar("phone", { length: 30 }),
    email: varchar("email", { length: 255 }),
    address: varchar("address", { length: 255 }),
    designation: varchar("designation", { length: 100 }),
    department: varchar("department", { length: 100 }),
    joiningDate: date("joining_date", { mode: "string" }),
    employmentStatus: employeeStatusEnum("employment_status")
      .default("active")
      .notNull(),
    locationId: integer("location_id"),
    paymentMethod: varchar("payment_method", { length: 30 }),
    notes: varchar("notes", { length: 500 }),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("employees_business_code_unique").on(
      table.businessId,
      table.employeeCode,
    ),
    uniqueIndex("employees_id_business_uq").on(table.id, table.businessId),
    index("employees_business_status_idx").on(
      table.businessId,
      table.employmentStatus,
    ),
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "employees_location_business_fkey",
    }),
  ],
);

export interface SalaryAllowance {
  name: string;
  amount: number;
}

export const employeeSalaryStructures = pgTable(
  "employee_salary_structures",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    employeeId: integer("employee_id").notNull(),
    payType: salaryPayTypeEnum("pay_type").notNull(),
    /** Monthly amount, per-day rate, or per-hour rate by payType. */
    basicAmount: numeric("basic_amount", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).notNull(),
    /** Fixed allowances: [{ name, amount }] — full for monthly pay. */
    allowances: jsonb("allowances").default([]).notNull(),
    /** Overtime rate per hour; defaults to the per-hour basic at runtime. */
    overtimeRate: numeric("overtime_rate", {
      precision: 14,
      scale: 2,
      mode: "string",
    }),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Exactly one active structure per employee.
    uniqueIndex("employee_salary_structures_one_active_unique")
      .on(table.employeeId)
      .where(sql`${table.isActive} = true`),
    index("employee_salary_structures_business_idx").on(
      table.businessId,
      table.employeeId,
    ),
    foreignKey({
      columns: [table.employeeId, table.businessId],
      foreignColumns: [employees.id, employees.businessId],
      name: "employee_salary_structures_employee_business_fkey",
    }),
    check(
      "employee_salary_structures_basic_nonnegative_check",
      sql`${table.basicAmount} >= 0`,
    ),
  ],
);

export const salaryAdvances = pgTable(
  "salary_advances",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    employeeId: integer("employee_id").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2, mode: "string" }).notNull(),
    advanceDate: date("advance_date", { mode: "string" }).notNull(),
    /** Maintained by payroll deductions (FIFO); mirror of the ledger truth. */
    outstandingAmount: numeric("outstanding_amount", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).notNull(),
    reason: varchar("reason", { length: 255 }),
    journalEntryId: integer("journal_entry_id"),
    clientUuid: uuid("client_uuid"),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("salary_advances_client_uuid_unique").on(table.clientUuid),
    index("salary_advances_business_employee_idx").on(
      table.businessId,
      table.employeeId,
    ),
    foreignKey({
      columns: [table.employeeId, table.businessId],
      foreignColumns: [employees.id, employees.businessId],
      name: "salary_advances_employee_business_fkey",
    }),
    check(
      "salary_advances_amount_positive_check",
      sql`${table.amount} > 0 AND ${table.outstandingAmount} >= 0`,
    ),
  ],
);

export const payrollPeriods = pgTable(
  "payroll_periods",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    periodType: varchar("period_type", { length: 20 })
      .default("monthly")
      .notNull(),
    /** First of the month — the duplicate-processing guard. */
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    status: payrollPeriodStatusEnum("status").default("draft").notNull(),
    grossTotal: numeric("gross_total", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    netTotal: numeric("net_total", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    advanceRecoveryTotal: numeric("advance_recovery_total", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    approvedByUserId: integer("approved_by_user_id").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("payroll_periods_business_month_unique").on(
      table.businessId,
      table.periodStart,
    ),
    // Candidate key for the composite FK from payroll_records.
    uniqueIndex("payroll_periods_id_business_uq").on(
      table.id,
      table.businessId,
    ),
    check(
      "payroll_periods_monthly_start_check",
      sql`${table.periodStart} = date_trunc('month', ${table.periodStart})::date`,
    ),
    check(
      "payroll_periods_range_check",
      sql`${table.periodEnd} > ${table.periodStart}`,
    ),
  ],
);

export const payrollRecords = pgTable(
  "payroll_records",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    periodId: integer("period_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    workedDays: integer("worked_days").default(0).notNull(),
    absentDays: integer("absent_days").default(0).notNull(),
    leaveDays: integer("leave_days").default(0).notNull(),
    halfDays: integer("half_days").default(0).notNull(),
    overtimeHours: numeric("overtime_hours", {
      precision: 9,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    /** Hours worked — the hourly pay basis (attendance-derived when null). */
    workedHours: numeric("worked_hours", {
      precision: 9,
      scale: 2,
      mode: "string",
    }),
    basicAmount: numeric("basic_amount", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    allowancesTotal: numeric("allowances_total", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    overtimeAmount: numeric("overtime_amount", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    bonusAmount: numeric("bonus_amount", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    commissionAmount: numeric("commission_amount", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    otherDeductions: numeric("other_deductions", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    advanceDeduction: numeric("advance_deduction", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    grossAmount: numeric("gross_amount", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    netAmount: numeric("net_amount", {
      precision: 14,
      scale: 2,
      mode: "string",
    }).default("0").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Duplicate-processing guard: one record per employee per period.
    uniqueIndex("payroll_records_period_employee_unique").on(
      table.periodId,
      table.employeeId,
    ),
    // Candidate key for the composite FK from payroll_payments.
    uniqueIndex("payroll_records_id_business_uq").on(
      table.id,
      table.businessId,
    ),
    index("payroll_records_business_idx").on(table.businessId, table.periodId),
    foreignKey({
      columns: [table.periodId, table.businessId],
      foreignColumns: [payrollPeriods.id, payrollPeriods.businessId],
      name: "payroll_records_period_business_fkey",
    }),
    foreignKey({
      columns: [table.employeeId, table.businessId],
      foreignColumns: [employees.id, employees.businessId],
      name: "payroll_records_employee_business_fkey",
    }),
    check(
      "payroll_records_days_nonnegative_check",
      sql`${table.workedDays} >= 0 AND ${table.absentDays} >= 0 AND ${table.leaveDays} >= 0 AND ${table.halfDays} >= 0`,
    ),
  ],
);

export const payrollPayments = pgTable(
  "payroll_payments",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    payrollRecordId: integer("payroll_record_id").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2, mode: "string" }).notNull(),
    method: varchar("method", { length: 30 }),
    paymentAccountId: integer("payment_account_id"),
    paymentDate: date("payment_date", { mode: "string" }).notNull(),
    reference: varchar("reference", { length: 100 }),
    journalEntryId: integer("journal_entry_id"),
    clientUuid: uuid("client_uuid"),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("payroll_payments_client_uuid_unique").on(table.clientUuid),
    index("payroll_payments_record_idx").on(table.payrollRecordId),
    foreignKey({
      columns: [table.payrollRecordId, table.businessId],
      foreignColumns: [payrollRecords.id, payrollRecords.businessId],
      name: "payroll_payments_record_business_fkey",
    }),
    foreignKey({
      columns: [table.paymentAccountId, table.businessId],
      foreignColumns: [paymentAccounts.id, paymentAccounts.businessId],
      name: "payroll_payments_payment_account_business_fkey",
    }),
    check(
      "payroll_payments_amount_positive_check",
      sql`${table.amount} > 0`,
    ),
  ],
);
