import type { Request, Response } from "express";
import { z } from "zod";
import * as loyaltyService from "../../services/loyalty.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

const programSchema = z.object({
  earnRate: z.number().min(0).max(1000),
  redeemValue: z.number().min(0).max(100000),
  isActive: z.boolean(),
});

export async function getProgram(req: Request, res: Response) {
  try {
    const program = await loyaltyService.getLoyaltyProgram(getBusinessId(req));
    return res.status(200).json({ success: true, data: program });
  } catch (err) {
    return sendSafeError(res, err, "Unable to read the loyalty program.");
  }
}

export async function putProgram(req: Request, res: Response) {
  try {
    const parsed = programSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid loyalty program data.",
        errors: parsed.error.flatten(),
      });
    }
    const program = await loyaltyService.upsertLoyaltyProgram(
      getBusinessId(req),
      req.user?.id ?? null,
      parsed.data,
    );
    return res.status(200).json({ success: true, data: program });
  } catch (err) {
    return sendSafeError(res, err, "Unable to save the loyalty program.");
  }
}

export async function getCustomerLoyalty(req: Request, res: Response) {
  try {
    const customerId = Number(req.params.customerId);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid customer ID." });
    }
    const [balance, history] = await Promise.all([
      loyaltyService.getLoyaltyBalance(getBusinessId(req), customerId),
      loyaltyService.getLoyaltyHistory(getBusinessId(req), customerId),
    ]);
    return res
      .status(200)
      .json({ success: true, data: { balance, history } });
  } catch (err) {
    return sendSafeError(res, err, "Unable to read the loyalty account.");
  }
}
