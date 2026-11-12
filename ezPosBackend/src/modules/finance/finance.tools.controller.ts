import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import * as tools from "./finance.tools.service.js";
import type { CreateAssetInput, CreateLoanInput, RecordRepaymentInput } from "./finance.tools.service.js";

function parseId(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Invalid id parameter");
  }
  return id;
}

// --- Loans --------------------------------------------------------------------

export async function listLoans(_req: Request, res: Response) {
  try {
    const businessId = getBusinessId(_req);
    const rows = await tools.listLoans(businessId);
    res.json({ rows });
  } catch (err) {
    sendSafeError(res, err, "Failed to load loans.");
  }
}

export async function createLoan(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const body = req.body ?? {};
    const input: CreateLoanInput = {
      lenderType: body.lenderType,
      lenderName: String(body.lenderName ?? "").trim(),
      principal: Number(body.principal),
      interestRate: body.interestRate != null ? Number(body.interestRate) : null,
      loanDate: body.loanDate,
      dueDate: body.dueDate ?? null,
      installmentCount: body.installmentCount != null ? Number(body.installmentCount) : null,
      installmentAmount:
        body.installmentAmount != null ? Number(body.installmentAmount) : null,
      method: body.method ?? null,
      paymentAccountId: body.paymentAccountId != null ? Number(body.paymentAccountId) : null,
      notes: body.notes ?? null,
    };
    if (!input.lenderName || !Number.isFinite(input.principal) || input.principal <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "lenderName and a positive principal are required." });
    }
    const LENDER_TYPES = ["bank", "mfs", "owner", "other"] as const;
    if (!LENDER_TYPES.includes(input.lenderType as never)) {
      return res.status(400).json({
        success: false,
        message: "lenderType is required — one of bank, mfs, owner, other.",
      });
    }
    const loan = await tools.createLoan(businessId, input, req.user?.id ?? null);
    res.status(201).json(loan);
  } catch (err) {
    sendSafeError(res, err, "Failed to create the loan.");
  }
}

export async function listRepayments(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const rows = await tools.listLoanRepayments(businessId, parseId(req));
    res.json({ rows });
  } catch (err) {
    sendSafeError(res, err, "Failed to load loan repayments.");
  }
}

export async function recordRepayment(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const body = req.body ?? {};
    const principalAmount = Number(body.principalAmount);
    if (!Number.isFinite(principalAmount) || principalAmount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "A positive principalAmount is required." });
    }
    const input: RecordRepaymentInput = {
      principalAmount,
      interestAmount: body.interestAmount != null ? Number(body.interestAmount) : 0,
      paymentDate: body.paymentDate,
      method: body.method ?? null,
      paymentAccountId: body.paymentAccountId != null ? Number(body.paymentAccountId) : null,
      reference: body.reference ?? null,
      clientUuid: body.clientUuid ?? null,
    };
    const result = await tools.recordLoanRepayment(
      businessId,
      parseId(req),
      input,
      req.user?.id ?? null,
    );
    res.status(201).json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to record the loan repayment.");
  }
}

// --- Assets & depreciation ------------------------------------------------------

export async function listAssets(_req: Request, res: Response) {
  try {
    const businessId = getBusinessId(_req);
    const rows = await tools.listAssets(businessId);
    res.json({ rows });
  } catch (err) {
    sendSafeError(res, err, "Failed to load business assets.");
  }
}

export async function createAsset(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const body = req.body ?? {};
    const input: CreateAssetInput = {
      name: String(body.name ?? "").trim(),
      category: body.category,
      acquiredAt: body.acquiredAt,
      cost: Number(body.cost),
      salvageValue: body.salvageValue != null ? Number(body.salvageValue) : 0,
      usefulLifeMonths: Number(body.usefulLifeMonths),
      method: body.method ?? null,
      paymentAccountId: body.paymentAccountId != null ? Number(body.paymentAccountId) : null,
      locationId: body.locationId != null ? Number(body.locationId) : null,
      notes: body.notes ?? null,
    };
    if (
      !input.name ||
      !["equipment", "furniture", "vehicle", "other"].includes(input.category) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(input.acquiredAt)) ||
      !Number.isFinite(input.cost) ||
      input.cost <= 0 ||
      !Number.isInteger(input.usefulLifeMonths) ||
      input.usefulLifeMonths <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "name, category, acquiredAt (YYYY-MM-DD), positive cost and usefulLifeMonths are required.",
      });
    }
    const asset = await tools.createAsset(businessId, input, req.user?.id ?? null);
    res.status(201).json(asset);
  } catch (err) {
    sendSafeError(res, err, "Failed to create the asset.");
  }
}

export async function runDepreciation(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const period = typeof (req.body as { periodMonth?: string })?.periodMonth === "string"
      ? (req.body as { periodMonth: string }).periodMonth
      : undefined;
    let periodMonth = period;
    if (!periodMonth) {
      // Default: previous month, first day.
      const d = new Date();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - 1);
      periodMonth = d.toISOString().slice(0, 10);
    }
    const result = await tools.runDepreciation(
      businessId,
      periodMonth,
      req.user?.id ?? null,
    );
    res.json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to run depreciation.");
  }
}

// --- Balance sheet ----------------------------------------------------------------

export async function getBalanceSheet(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const asOfParam = req.query.asOf;
    const asOf =
      typeof asOfParam === "string" && /^\d{4}-\d{2}-\d{2}$/.test(asOfParam)
        ? asOfParam
        : undefined;
    const sheet = await tools.getBalanceSheet(businessId, asOf);
    res.json(sheet);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the balance sheet.");
  }
}
