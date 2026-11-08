import type { Request, Response } from "express";
import * as purchaseReturnService from "./purchaseReturn.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import { createPurchaseReturnSchema } from "./purchaseReturn.schema.js";
import { purchaseReturnPreviewSchema } from "./purchaseReturn.preview.schema.js";
import * as purchaseReturnPreviewService from "./purchaseReturn.preview.service.js";

export async function createPurchaseReturn(req: Request, res: Response) {
  try {
    const parsedInput = createPurchaseReturnSchema.safeParse(req.body);
    if (!parsedInput.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid purchase return data.",
        errors: parsedInput.error.flatten(),
      });
    }
    const result = await purchaseReturnService.createPurchaseReturn(
      getBusinessId(req),
      parsedInput.data,
      req.user?.id,
    );
    return res.status(201).json(result);
  } catch (err) {
    sendSafeError(res, err, "Unable to process the purchase return.");
  }
}
/**
 * Return preview (Phase 2): the server's own numbers for the proposed
 * return — goods credit at batch costs, landed-cost reversal per the
 * document's state, supplier-balance split. Informational: issues are
 * REPORTED (canSubmit false) rather than thrown; the committing return
 * still enforces everything transactionally.
 */
export async function previewPurchaseReturn(req: Request, res: Response) {
  try {
    const purchaseId = Number(req.params.purchaseId);
    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid purchase order id." });
    }
    const parsedInput = purchaseReturnPreviewSchema.safeParse(req.body ?? {});
    if (!parsedInput.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid purchase return preview data.",
        errors: parsedInput.error.flatten(),
      });
    }
    const result = await purchaseReturnPreviewService.previewPurchaseReturn(
      getBusinessId(req),
      purchaseId,
      parsedInput.data,
    );
    return res.status(200).json(result);
  } catch (err) {
    sendSafeError(res, err, "Unable to preview the purchase return.");
  }
}

export async function getReturnableSerials(req: Request, res: Response) {
  try {
    const purchaseId = Number(req.params.purchaseId);
    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid purchase order id." });
    }
    const result = await purchaseReturnService.getReturnableSerials(
      getBusinessId(req),
      purchaseId,
    );
    return res.status(200).json(result);
  } catch (err) {
    sendSafeError(res, err, "Unable to load returnable serial numbers.");
  }
}

export async function getPurchaseReturnItems(req: Request, res: Response) {
  try {
    const returnItems = await purchaseReturnService.getPurchaseReturnItems(
      getBusinessId(req),
    );
    res.json(returnItems);
  } catch (err) {
    sendSafeError(res, err, "Unable to load purchase return items.");
  }
}
