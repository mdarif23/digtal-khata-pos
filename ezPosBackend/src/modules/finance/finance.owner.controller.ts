import type { Request, Response } from "express";
import type { ZodType } from "zod";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import * as ownerService from "./finance.owner.service.js";
import * as profitService from "./finance.profit.service.js";
import {
  capitalListQuerySchema,
  capitalTransactionSchema,
  createAllocationSchema,
  createOwnerSchema,
  profitRangeQuerySchema,
  realizeAllocationSchema,
  reverseAllocationSchema,
  updateOwnerSchema,
} from "./finance.owner.schema.js";
import type {
  CapitalListQuery,
  CapitalTransactionInput,
  CreateAllocationInput,
  CreateOwnerInput,
  ProfitRangeQuery,
  RealizeAllocationInput,
  ReverseAllocationInput,
  UpdateOwnerInput,
} from "./finance.owner.schema.js";

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

// --- Owner profiles -----------------------------------------------------------

export async function listOwners(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const rows = await ownerService.listOwners(
      businessId,
      req.query.include_inactive === "true",
    );
    res.json({ rows });
  } catch (err) {
    sendSafeError(res, err, "Failed to load owner profiles.");
  }
}

export async function createOwner(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(res, createOwnerSchema, req, "Invalid owner payload.");
    const owner = await ownerService.createOwner(
      businessId,
      input as CreateOwnerInput,
      req.user!.id,
    );
    res.status(201).json(owner);
  } catch (err) {
    sendSafeError(res, err, "Failed to create the owner profile.");
  }
}

export async function updateOwner(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(res, updateOwnerSchema, req, "Invalid owner payload.");
    const owner = await ownerService.updateOwner(
      businessId,
      parseId(req),
      input as UpdateOwnerInput,
      req.user!.id,
    );
    res.json(owner);
  } catch (err) {
    sendSafeError(res, err, "Failed to update the owner profile.");
  }
}

// --- Capital transactions -------------------------------------------------------

export async function listCapitalTransactions(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const parsed = capitalListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return validationError(res, "Invalid query parameters.", parsed.error);
    }
    const result = await ownerService.listCapitalTransactions(
      businessId,
      parsed.data as CapitalListQuery,
    );
    res.json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to load capital transactions.");
  }
}

export async function recordCapitalTransaction(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(
      res,
      capitalTransactionSchema,
      req,
      "Invalid capital transaction payload.",
    );
    const result = await ownerService.recordCapitalTransaction(
      businessId,
      input as CapitalTransactionInput,
      req.user?.id ?? null,
    );
    res.status(201).json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to record the capital transaction.");
  }
}

export async function getCapitalSummary(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const summary = await ownerService.getCapitalSummary(businessId);
    res.json(summary);
  } catch (err) {
    sendSafeError(res, err, "Failed to load the owner capital summary.");
  }
}

// --- Profit & allocations ---------------------------------------------------------

export async function getProfit(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const parsed = profitRangeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return validationError(res, "Invalid date range.", parsed.error);
    }
    const { from, to } = parsed.data as ProfitRangeQuery;
    const figures = await profitService.calculateProfit(businessId, from, to);
    res.json(figures);
  } catch (err) {
    sendSafeError(res, err, "Failed to calculate profit.");
  }
}

export async function listAllocations(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const rows = await profitService.listAllocations(businessId);
    res.json({ rows });
  } catch (err) {
    sendSafeError(res, err, "Failed to load profit allocations.");
  }
}

export async function createAllocation(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(
      res,
      createAllocationSchema,
      req,
      "Invalid allocation payload.",
    );
    const allocation = await profitService.createAllocation(
      businessId,
      input as CreateAllocationInput,
      req.user!.id,
    );
    res.status(201).json(allocation);
  } catch (err) {
    sendSafeError(res, err, "Failed to create the profit allocation.");
  }
}

export async function reverseAllocation(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(
      res,
      reverseAllocationSchema,
      req,
      "A reversal reason is required.",
    );
    const allocation = await profitService.reverseAllocation(
      businessId,
      parseId(req),
      (input as ReverseAllocationInput).reason,
      req.user!.id,
    );
    res.json(allocation);
  } catch (err) {
    sendSafeError(res, err, "Failed to reverse the profit allocation.");
  }
}

export async function realizeAllocationLine(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(
      res,
      realizeAllocationSchema,
      req,
      "Invalid realization payload.",
    );
    const result = await profitService.realizeAllocationLine(
      businessId,
      parseId(req),
      input as RealizeAllocationInput,
      req.user?.id ?? null,
    );
    res.status(201).json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to realize the allocation share.");
  }
}
