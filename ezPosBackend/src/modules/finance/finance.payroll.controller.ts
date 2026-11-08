import type { Request, Response } from "express";
import type { ZodType } from "zod";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import * as payroll from "./finance.payroll.service.js";
import * as periods from "./finance.payroll.periods.service.js";
import {
  createEmployeeSchema,
  createPayrollPeriodSchema,
  createSalaryStructureSchema,
  employeeListQuerySchema,
  giveAdvanceSchema,
  salaryPaymentSchema,
  updateEmployeeSchema,
  updatePayrollRecordSchema,
} from "./finance.payroll.schema.js";
import type {
  CreateEmployeeInput,
  CreatePayrollPeriodInput,
  CreateSalaryStructureInput,
  EmployeeListQuery,
  GiveAdvanceInput,
  SalaryPaymentInput,
  UpdateEmployeeInput,
  UpdatePayrollRecordInput,
} from "./finance.payroll.schema.js";

/** Platform-wide validation error envelope ({ success, message, errors }). */
function validationError(res: Response, message: string, errors: unknown) {
  return res.status(400).json({ success: false, message, errors });
}

function parseId(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Invalid id parameter");
  }
  return id;
}

function parseBody<T>(
  res: Response,
  schema: ZodType<T>,
  req: Request,
  message: string,
): T {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    validationError(res, message, parsed.error);
    throw new Error("validation-short-circuit");
  }
  return parsed.data;
}

// --- Employees ---------------------------------------------------------------

export async function listEmployees(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const parsed = employeeListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return validationError(res, "Invalid query parameters.", parsed.error);
    }
    const result = await payroll.listEmployees(
      businessId,
      parsed.data as EmployeeListQuery,
    );
    res.json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to load employees.");
  }
}

export async function getEmployee(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const employee = await payroll.getEmployee(businessId, parseId(req));
    res.json(employee);
  } catch (err) {
    sendSafeError(res, err, "Failed to load the employee.");
  }
}

export async function createEmployee(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(res, createEmployeeSchema, req, "Invalid employee payload.");
    const employee = await payroll.createEmployee(
      businessId,
      input as CreateEmployeeInput,
      req.user!.id,
    );
    res.status(201).json(employee);
  } catch (err) {
    sendSafeError(res, err, "Failed to create the employee.");
  }
}

export async function updateEmployee(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(res, updateEmployeeSchema, req, "Invalid employee payload.");
    const employee = await payroll.updateEmployee(
      businessId,
      parseId(req),
      input as UpdateEmployeeInput,
      req.user!.id,
    );
    res.json(employee);
  } catch (err) {
    sendSafeError(res, err, "Failed to update the employee.");
  }
}

export async function createSalaryStructure(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(
      res,
      createSalaryStructureSchema,
      req,
      "Invalid salary structure payload.",
    );
    const structure = await payroll.createSalaryStructure(
      businessId,
      parseId(req),
      input as CreateSalaryStructureInput,
      req.user!.id,
    );
    res.status(201).json(structure);
  } catch (err) {
    sendSafeError(res, err, "Failed to create the salary structure.");
  }
}

export async function giveAdvance(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(res, giveAdvanceSchema, req, "Invalid advance payload.");
    const result = await payroll.giveAdvance(
      businessId,
      { ...(input as GiveAdvanceInput), employeeId: parseId(req) },
      req.user?.id ?? null,
    );
    res.status(201).json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to record the salary advance.");
  }
}

export async function listAdvances(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const rows = await payroll.listAdvances(businessId, parseId(req));
    res.json({ rows });
  } catch (err) {
    sendSafeError(res, err, "Failed to load salary advances.");
  }
}

// --- Payroll periods -----------------------------------------------------------

export async function createPeriod(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(
      res,
      createPayrollPeriodSchema,
      req,
      "Invalid payroll period payload.",
    );
    const period = await periods.createPayrollPeriod(
      businessId,
      input as CreatePayrollPeriodInput,
      req.user!.id,
    );
    res.status(201).json(period);
  } catch (err) {
    sendSafeError(res, err, "Failed to create the payroll period.");
  }
}

export async function listPeriods(_req: Request, res: Response) {
  try {
    const businessId = getBusinessId(_req);
    const rows = await periods.listPeriods(businessId);
    res.json({ rows });
  } catch (err) {
    sendSafeError(res, err, "Failed to load payroll periods.");
  }
}

export async function getPeriod(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const period = await periods.getPeriod(businessId, parseId(req));
    res.json(period);
  } catch (err) {
    sendSafeError(res, err, "Failed to load the payroll period.");
  }
}

export async function updateRecord(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(
      res,
      updatePayrollRecordSchema,
      req,
      "Invalid payroll record payload.",
    );
    const record = await periods.updatePayrollRecord(
      businessId,
      parseId(req),
      Number(req.params.recordId),
      input as UpdatePayrollRecordInput,
      req.user!.id,
    );
    res.json(record);
  } catch (err) {
    sendSafeError(res, err, "Failed to update the payroll record.");
  }
}

export async function approvePeriod(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const period = await periods.approvePayrollPeriod(
      businessId,
      parseId(req),
      req.user!.id,
    );
    res.json(period);
  } catch (err) {
    sendSafeError(res, err, "Failed to approve the payroll period.");
  }
}

export async function cancelPeriod(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const reason =
      typeof (req.body as { reason?: string })?.reason === "string"
        ? (req.body as { reason: string }).reason
        : "";
    const period = await periods.cancelPayrollPeriod(
      businessId,
      parseId(req),
      reason,
      req.user!.id,
    );
    res.json(period);
  } catch (err) {
    sendSafeError(res, err, "Failed to cancel the payroll period.");
  }
}

export async function reopenPeriod(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const period = await periods.reopenPayrollPeriod(
      businessId,
      parseId(req),
      req.user!.id,
    );
    res.json(period);
  } catch (err) {
    sendSafeError(res, err, "Failed to reopen the payroll period.");
  }
}

// --- Payments & payslips ---------------------------------------------------------

export async function recordPayment(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(
      res,
      salaryPaymentSchema,
      req,
      "Invalid salary payment payload.",
    );
    const result = await periods.recordSalaryPayment(
      businessId,
      Number(req.params.recordId),
      input as SalaryPaymentInput,
      req.user?.id ?? null,
    );
    res.status(201).json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to record the salary payment.");
  }
}

export async function voidPayment(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const result = await periods.voidSalaryPayment(
      businessId,
      parseId(req),
      req.user!.id,
    );
    res.json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to void the salary payment.");
  }
}

export async function getPayslip(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const payslip = await periods.getPayslip(businessId, Number(req.params.recordId));
    res.json(payslip);
  } catch (err) {
    sendSafeError(res, err, "Failed to load the payslip.");
  }
}
