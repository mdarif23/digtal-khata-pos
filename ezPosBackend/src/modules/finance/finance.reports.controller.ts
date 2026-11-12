import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import { safeCsvCell } from "../../utils/csv.js";
import * as reports from "./finance.reports.service.js";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

function dateParam(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === "string" && isoDate.test(value) ? value : undefined;
}

function requireRange(req: Request): { from: string; to: string } | null {
  const from = dateParam(req, "from");
  const to = dateParam(req, "to");
  if (!from || !to || from > to) return null;
  return { from, to };
}

/** RFC 4180-ish CSV with a BOM so Excel opens UTF-8 correctly. */
function csvResponse(
  res: Response,
  filename: string,
  columns: { key: string; label: string }[],
  rows: Record<string, unknown>[],
): void {
  // safeCsvCell = formula-injection guard + RFC-4180 escaping (Phase 1):
  // report labels/rows can embed user input (customer names, references).
  const lines = [
    columns.map((c) => safeCsvCell(c.label)).join(","),
    ...rows.map((row) => columns.map((c) => safeCsvCell(row[c.key])).join(",")),
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  res.send(`\uFEFF${lines.join("\r\n")}`);
}

function wantsCsv(req: Request): boolean {
  return req.query.format === "csv";
}

function unauthorizedRange(res: Response): Response {
  return res.status(400).json({
    success: false,
    message: "Provide from and to dates (YYYY-MM-DD, from ≤ to).",
  });
}

export async function getPnl(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const range = requireRange(req);
    if (!range) return unauthorizedRange(res);
    const report = await reports.getProfitAndLoss(businessId, range.from, range.to);
    if (wantsCsv(req)) {
      const rows = [
        ...report.revenue.lines.map((l) => ({
          section: "Revenue", code: l.code, name: l.name, amount: l.balance,
        })),
        { section: "Cost of goods sold", code: "5010", name: "COGS", amount: report.cogs },
        { section: "Gross profit", code: "", name: "Gross profit", amount: report.grossProfit },
        ...report.operatingExpenses.lines.map((l) => ({
          section: "Operating expenses", code: l.code, name: l.name, amount: l.balance,
        })),
        { section: "Operating profit", code: "", name: "Operating profit", amount: report.operatingProfit },
        { section: "Interest", code: "5090", name: "Loan interest", amount: report.interest },
        { section: "Net profit", code: "", name: "Net profit", amount: report.netProfit },
      ];
      return csvResponse(res, "profit-and-loss", [
        { key: "section", label: "Section" },
        { key: "code", label: "Account" },
        { key: "name", label: "Line" },
        { key: "amount", label: "Amount" },
      ], rows);
    }
    res.json(report);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the P&L statement.");
  }
}

export async function getOwnerInvestments(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const range = requireRange(req);
    if (!range) return unauthorizedRange(res);
    const report = await reports.getOwnerCapitalReport(businessId, range.from, range.to, "investment");
    if (wantsCsv(req)) {
      return csvResponse(res, "owner-investments", report.columns, report.rows);
    }
    res.json(report);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the owner investment report.");
  }
}

export async function getOwnerWithdrawals(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const range = requireRange(req);
    if (!range) return unauthorizedRange(res);
    const report = await reports.getOwnerCapitalReport(businessId, range.from, range.to, "withdrawal");
    if (wantsCsv(req)) {
      return csvResponse(res, "owner-withdrawals", report.columns, report.rows);
    }
    res.json(report);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the owner withdrawal report.");
  }
}

export async function getProfitAllocations(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const range = requireRange(req);
    if (!range) return unauthorizedRange(res);
    const report = await reports.getAllocationReport(businessId, range.from, range.to);
    res.json(report);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the profit allocation report.");
  }
}

export async function getRetainedEarnings(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const range = requireRange(req);
    if (!range) return unauthorizedRange(res);
    const report = await reports.getRetainedEarningsReport(businessId, range.from, range.to);
    res.json(report);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the retained earnings report.");
  }
}

export async function getPayrollReport(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const range = requireRange(req);
    if (!range) return unauthorizedRange(res);
    const report = await reports.getPayrollReport(businessId, range.from, range.to);
    if (wantsCsv(req)) {
      return csvResponse(res, "payroll", report.columns, report.rows);
    }
    res.json(report);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the payroll report.");
  }
}

export async function getSalaryOutstanding(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const report = await reports.getSalaryOutstandingReport(businessId);
    if (wantsCsv(req)) {
      return csvResponse(res, "salary-outstanding", report.columns, report.rows);
    }
    res.json(report);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the salary outstanding report.");
  }
}

export async function getLoanOutstanding(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const report = await reports.getLoanOutstandingReport(businessId);
    if (wantsCsv(req)) {
      return csvResponse(res, "loan-outstanding", report.columns, report.rows);
    }
    res.json(report);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the loan outstanding report.");
  }
}

export async function getBudgetVariance(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const range = requireRange(req);
    if (!range) return unauthorizedRange(res);
    const report = await reports.getBudgetVarianceReport(businessId, range.from, range.to);
    if (wantsCsv(req)) {
      return csvResponse(res, "budget-variance", report.columns, report.rows);
    }
    res.json(report);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the budget variance report.");
  }
}

export async function getTransactions(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const range = requireRange(req);
    if (!range) return unauthorizedRange(res);
    const sourceType =
      typeof req.query.source_type === "string" ? req.query.source_type : undefined;
    const report = await reports.getTransactionReport(
      businessId,
      range.from,
      range.to,
      sourceType,
    );
    if (wantsCsv(req)) {
      // One row per journal line (the flattening an accountant expects).
      const flat = report.rows.flatMap((entry) =>
        entry.lines.map((line) => ({
          entryDate: entry.entryDate,
          entryNo: entry.entryNo,
          sourceType: entry.sourceType,
          status: entry.status,
          accountCode: line.accountCode,
          accountName: line.accountName,
          debit: line.debit,
          credit: line.credit,
          description: line.description,
          memo: entry.memo,
        })),
      );
      return csvResponse(res, "financial-transactions", report.columns, flat);
    }
    res.json(report);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the transaction report.");
  }
}

export async function getReconciliation(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const report = await reports.getReconciliation(businessId);
    res.json(report);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the reconciliation report.");
  }
}

export async function getAuditTrail(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 25));
    const result = await reports.listAuditTrail(businessId, {
      ...(typeof req.query.action === "string" ? { action: req.query.action } : {}),
      ...(typeof req.query.entity_type === "string"
        ? { entityType: req.query.entity_type }
        : {}),
      ...(req.query.entity_id != null && Number.isInteger(Number(req.query.entity_id))
        ? { entityId: Number(req.query.entity_id) }
        : {}),
      ...(dateParam(req, "from") != null ? { from: dateParam(req, "from")! } : {}),
      ...(dateParam(req, "to") != null ? { to: dateParam(req, "to")! } : {}),
      page,
      pageSize,
    });
    res.json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to load the audit trail.");
  }
}
