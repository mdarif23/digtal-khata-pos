import type { Request, Response } from "express";
import * as purchasesService from "./purchases.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { getLocationId } from "../../middleware/location.js";
import { sendSafeError } from "../../utils/safeError.js";
import { createPurchaseSchema } from "./schemas/purchase.schema.js";
import { receiveItemsFormSchema } from "./schemas/receiveItem.schema.js";

export async function createPurchase(req: Request, res: Response) {
  try {
    const result = createPurchaseSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid purchase data",
        errors: result.error.flatten(),
      });
    }
    const purchase = await purchasesService.createPurchase(
      getBusinessId(req),
      result.data,
    );
    return res.status(201).json({
      message: "Purchase created successfully",
      data: purchase,
    });
  } catch (err) {
    return sendSafeError(res, err, "Unable to create the purchase.");
  }
}
export async function getPurchasesSummary(req: Request, res: Response) {
  try {
    const result = await purchasesService.getPurchasesSummary(getBusinessId(req));
    res.status(200).json(result);
  } catch (err) {
    sendSafeError(res, err, "Unable to load purchases.");
  }
}
export async function getPurchasesItems(req: Request, res: Response) {
  try {
    const result = await purchasesService.getPurchasesItems(
      getBusinessId(req),
      getLocationId(req),
    );
    res.status(200).json(result);
  } catch (err) {
    sendSafeError(res, err, "Unable to load purchase items.");
  }
}
export async function createReceivePurchase(req: Request, res: Response) {
  try {
    const result = receiveItemsFormSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid Purchase Data",
        errors: result.error.flatten(),
      });
    }
    const receivedItems = await purchasesService.createReceivePurchase(
      getBusinessId(req),
      getLocationId(req),
      result.data,
      req.user?.id,
    );
    res.status(201).json({
      message: "Purchase order updated successfully",
      data: receivedItems,
    });
  } catch (err) {
    return sendSafeError(res, err, "Unable to receive the purchase.");
  }
}
