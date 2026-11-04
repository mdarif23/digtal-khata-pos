import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import {
  createLandedCostDocument,
  updateLandedCostDocument,
  getLandedCostDocument,
  postLandedCostDocument,
} from "./landed-cost.lifecycle.js";
import { sendSafeError } from "../../utils/safeError.js";
import {
  getLandedCostContext,
  computeLandedCostPreview,
  type LandedCostContext,
  type LandedCostPreview,
} from "./landed-cost.service.js";
import {
  landedCostPreviewSchema,
  type LandedCostPreviewInput,
} from "./landed-cost.validation.js";
import { LandedCostValidationError } from "./landed-cost.calculator.js";

function parsePreviewInput(req: Request): LandedCostPreviewInput {
  const parsed = landedCostPreviewSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new LandedCostValidationError([
      {
        code: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join(", "),
      },
    ]);
  }
  return parsed.data;
}

/**
 * GET /api/purchases/:purchaseId/landed-cost — document context: purchase
 * header, received lines with batches and weights, existing document status.
 */
export async function getLandedCost(req: Request, res: Response) {
  try {
    const purchaseId = Number(req.params.purchaseId);
    const context: LandedCostContext = await getLandedCostContext(
      getBusinessId(req),
      purchaseId,
    );
    res.status(200).json({ success: true, data: context });
  } catch (err) {
    if (err instanceof LandedCostValidationError) {
      res.status(400).json({
        success: false,
        message: err.issues.map((i) => i.message).join(" "),
        issues: err.issues,
      });
      return;
    }
    sendSafeError(res, err, "Landed-cost request failed.");
  }
}

function parseDocumentInput(req: Request) {
  const parsed = landedCostPreviewSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new LandedCostValidationError([
      {
        code: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join(", "),
      },
    ]);
  }
  return {
    method: parsed.data.method,
    expenses: parsed.data.expenses,
    ...(parsed.data.manualAllocations
      ? { manualAllocations: parsed.data.manualAllocations }
      : {}),
  };
}

/**
 * POST /api/purchases/:purchaseId/landed-cost — create the draft document
 * (one per purchase).
 */
export async function createLandedCost(req: Request, res: Response) {
  try {
    const doc = await createLandedCostDocument(
      getBusinessId(req),
      Number(req.params.purchaseId),
      req.user!.id,
      parseDocumentInput(req),
    );
    res.status(201).json({ success: true, data: doc });
  } catch (err) {
    if (err instanceof LandedCostValidationError) {
      res.status(400).json({
        success: false,
        message: err.issues.map((i) => i.message).join(" "),
        issues: err.issues,
      });
      return;
    }
    sendSafeError(res, err, "Unable to create the landed-cost document.");
  }
}

/** GET /api/landed-costs/:id — full document detail. */
export async function getLandedCostDoc(req: Request, res: Response) {
  try {
    const data = await getLandedCostDocument(
      getBusinessId(req),
      Number(req.params.id),
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafeError(res, err, "Landed-cost document not found.");
  }
}

/** PATCH /api/landed-costs/:id — edit method/expenses while draft. */
export async function updateLandedCost(req: Request, res: Response) {
  try {
    const doc = await updateLandedCostDocument(
      getBusinessId(req),
      Number(req.params.id),
      req.user!.id,
      parseDocumentInput(req),
    );
    res.status(200).json({ success: true, data: doc });
  } catch (err) {
    if (err instanceof LandedCostValidationError) {
      res.status(400).json({
        success: false,
        message: err.issues.map((i) => i.message).join(" "),
        issues: err.issues,
      });
      return;
    }
    sendSafeError(res, err, "Unable to update the landed-cost document.");
  }
}

/** POST /api/landed-costs/:id/post — allocate to batches (draft → posted). */
export async function postLandedCost(req: Request, res: Response) {
  try {
    const result = await postLandedCostDocument(
      getBusinessId(req),
      Number(req.params.id),
      req.user!.id,
    );
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    sendSafeError(res, err, "Unable to post the landed-cost document.");
  }
}

/**
 * POST /api/purchases/:purchaseId/landed-cost/preview — runs the allocation
 * engine for the given expenses/method. Pure calculation; nothing persists.
 * The posting flow re-runs this exact function inside its transaction, so a
 * preview can never drift from what gets posted.
 */
export async function previewLandedCost(req: Request, res: Response) {
  try {
    const purchaseId = Number(req.params.purchaseId);
    const input = parsePreviewInput(req);
    const context = await getLandedCostContext(
      getBusinessId(req),
      purchaseId,
    );
    const preview: LandedCostPreview = computeLandedCostPreview(
      context.lines,
      input,
    );
    res.status(200).json({ success: true, data: preview });
  } catch (err) {
    if (err instanceof LandedCostValidationError) {
      res.status(400).json({
        success: false,
        message: err.issues.map((i) => i.message).join(" "),
        issues: err.issues,
      });
      return;
    }
    sendSafeError(res, err, "Landed-cost request failed.");
  }
}
