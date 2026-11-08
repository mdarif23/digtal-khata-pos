import { z } from "zod";

/**
 * Staff & Payroll (Stage 5) request schemas.
 */

const money = z
  .number()
  .nonnegative()
  .refine((value) => Number.isFinite(value), "Must be a finite number")
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.01,
    "At most 2 decimal places",
  );

const positiveMoney = z
  .number()
  .positive()
  .refine((value) => Number.isFinite(value), "Must be a finite number")
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.01,
    "At most 2 decimal places",
  );

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const monthStart = isoDate.refine(
  (value) => value.endsWith("-01"),
  "Payroll periods start on the first of the month",
);

// --- Employees ----------------------------------------------------------------

export const allowanceSchema = z.object({
  name: z.string().trim().min(1).max(60),
  amount: money,
});

export const createEmployeeSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  userId: z.coerce.number().int().positive().nullish(),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().email().max(255).nullish(),
  address: z.string().trim().max(255).nullish(),
  designation: z.string().trim().max(100).nullish(),
  department: z.string().trim().max(100).nullish(),
  joiningDate: isoDate.nullish(),
  locationId: z.coerce.number().int().positive().nullish(),
  paymentMethod: z.string().trim().max(30).nullish(),
  notes: z.string().trim().max(500).nullish(),
  /** Optional initial salary structure (created atomically). */
  salaryStructure: z
    .object({
      payType: z.enum(["monthly", "daily", "hourly"]),
      basicAmount: money,
      allowances: z.array(allowanceSchema).default([]),
      overtimeRate: money.nullish(),
      effectiveFrom: isoDate.optional(),
    })
    .nullish(),
});
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

export const updateEmployeeSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().email().max(255).nullish(),
  address: z.string().trim().max(255).nullish(),
  designation: z.string().trim().max(100).nullish(),
  department: z.string().trim().max(100).nullish(),
  joiningDate: isoDate.nullish(),
  employmentStatus: z.enum(["active", "inactive", "terminated"]).optional(),
  locationId: z.coerce.number().int().positive().nullish(),
  paymentMethod: z.string().trim().max(30).nullish(),
  notes: z.string().trim().max(500).nullish(),
});
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

export const createSalaryStructureSchema = z.object({
  payType: z.enum(["monthly", "daily", "hourly"]),
  basicAmount: money,
  allowances: z.array(allowanceSchema).default([]),
  overtimeRate: money.nullish(),
  effectiveFrom: isoDate.optional(),
});
export type CreateSalaryStructureInput = z.infer<typeof createSalaryStructureSchema>;

export const employeeListQuerySchema = z.object({
  status: z.enum(["active", "inactive", "terminated"]).optional(),
  department: z.string().trim().max(100).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});
export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;

// --- Advances -------------------------------------------------------------------

export const giveAdvanceSchema = z.object({
  /** Injected from the URL by the controller; not sent by clients. */
  employeeId: z.coerce.number().int().positive().optional(),
  amount: positiveMoney,
  advanceDate: isoDate.optional(),
  reason: z.string().trim().max(255).nullish(),
  method: z.string().trim().max(30).nullish(),
  paymentAccountId: z.coerce.number().int().positive().nullish(),
  clientUuid: z.string().uuid().nullish(),
});
export type GiveAdvanceInput = z.infer<typeof giveAdvanceSchema>;

// --- Payroll periods --------------------------------------------------------------

export const payrollRecordInputSchema = z.object({
  employeeId: z.coerce.number().int().positive(),
  workedDays: z.coerce.number().int().min(0).max(62).optional(),
  absentDays: z.coerce.number().int().min(0).max(31).optional(),
  leaveDays: z.coerce.number().int().min(0).max(31).optional(),
  halfDays: z.coerce.number().int().min(0).max(31).optional(),
  overtimeHours: z.number().min(0).max(500).optional(),
  workedHours: z.number().min(0).max(744).nullish(),
  bonusAmount: money.optional(),
  commissionAmount: money.optional(),
  otherDeductions: money.optional(),
  /** Taken from the employee's open advances (FIFO), validated server-side. */
  advanceDeduction: money.optional(),
});
export type PayrollRecordInput = z.infer<typeof payrollRecordInputSchema>;

export const createPayrollPeriodSchema = z.object({
  periodStart: monthStart,
  /** Defaults to the last day of the month. */
  periodEnd: isoDate.optional(),
  employeeIds: z.array(z.coerce.number().int().positive()).min(1),
  records: z.array(payrollRecordInputSchema).default([]),
});
export type CreatePayrollPeriodInput = z.infer<typeof createPayrollPeriodSchema>;

export const updatePayrollRecordSchema = z.object({
  workedDays: z.coerce.number().int().min(0).max(62).optional(),
  absentDays: z.coerce.number().int().min(0).max(31).optional(),
  leaveDays: z.coerce.number().int().min(0).max(31).optional(),
  halfDays: z.coerce.number().int().min(0).max(31).optional(),
  overtimeHours: z.number().min(0).max(500).optional(),
  workedHours: z.number().min(0).max(744).nullish(),
  bonusAmount: money.optional(),
  commissionAmount: money.optional(),
  otherDeductions: money.optional(),
  advanceDeduction: money.optional(),
});
export type UpdatePayrollRecordInput = z.infer<typeof updatePayrollRecordSchema>;

export const salaryPaymentSchema = z.object({
  amount: positiveMoney,
  method: z.string().trim().max(30).nullish(),
  paymentAccountId: z.coerce.number().int().positive().nullish(),
  paymentDate: isoDate.optional(),
  reference: z.string().trim().max(100).nullish(),
  clientUuid: z.string().uuid().nullish(),
});
export type SalaryPaymentInput = z.infer<typeof salaryPaymentSchema>;
