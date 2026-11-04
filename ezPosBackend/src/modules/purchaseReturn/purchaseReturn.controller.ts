import type { Request, Response } from "express";
import * as purchaseReturnService from "./purchaseReturn.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import { createPurchaseReturnSchema } from "./purchaseReturn.schema.js";

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
