import type { Request, Response } from "express";
import { z } from "zod";
import * as loyaltyService from "../../services/loyalty.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import { recordAudit } from "../../services/audit.js";
import { db } from "../../db/schema/index.js";
import { BadRequestError } from "../../utils/handleError.js";

const programSchema = z.object({
  earnRate: z.number().min(0).max(1000),
  redeemValue: z.number().min(0).max(100000),
  isActive: z.boolean(),
  expiryMode: z.enum(["none", "fixed"]).optional(),
  expiryDays: z.number().int().positive().max(3650).nullable().optional(),
  minRedemptionPoints: z.number().min(0).max(1_000_000).optional(),
  maxRedemptionPointsPerSale: z.number().positive().max(1_000_000).nullable().optional(),
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

/** POS-readable redemption config (no manage permission required). */
export async function getPosConfig(req: Request, res: Response) {
  try {
    const program = await loyaltyService.getLoyaltyProgram(getBusinessId(req));
    if (!program || !program.isActive) {
      return res.status(200).json({ success: true, data: null });
    }
    return res.status(200).json({
      success: true,
      data: {
        redeemValue: program.redeemValue,
        earnRate: program.earnRate,
        minRedemptionPoints: program.minRedemptionPoints,
        maxRedemptionPointsPerSale: program.maxRedemptionPointsPerSale,
      },
    });
  } catch (err) {
    return sendSafeError(res, err, "Unable to read the loyalty config.");
  }
}

const ruleSchema = z.object({
  isActive: z.boolean(),
  minTransactionAmount: z.number().min(0).max(10_000_000),
  excludedCategoryIds: z.array(z.number().int().positive()).max(100),
  excludedProductIds: z.array(z.number().int().positive()).max(500),
  bonusPoints: z.number().min(0).max(1_000_000),
  multiplier: z.number().min(0).max(100),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export async function getRule(req: Request, res: Response) {
  try {
    const rule = await loyaltyService.getEarnRule(getBusinessId(req));
    return res.status(200).json({ success: true, data: rule });
  } catch (err) {
    return sendSafeError(res, err, "Unable to read the earning rule.");
  }
}

export async function putRule(req: Request, res: Response) {
  try {
    const parsed = ruleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid earning rule.",
        errors: parsed.error.flatten(),
      });
    }
    const rule = await loyaltyService.upsertEarnRule(getBusinessId(req), {
      isActive: parsed.data.isActive,
      minTransactionAmount: parsed.data.minTransactionAmount,
      excludedCategoryIds: parsed.data.excludedCategoryIds,
      excludedProductIds: parsed.data.excludedProductIds,
      bonusPoints: parsed.data.bonusPoints,
      multiplier: parsed.data.multiplier,
      startsAt: parsed.data.startsAt ? new Date(parsed.data.startsAt) : null,
      endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : null,
    });
    recordAudit({
      businessId: getBusinessId(req),
      actorUserId: req.user?.id ?? null,
      action: "loyalty.rule_updated",
      entityType: "loyalty_earn_rule",
      entityId: getBusinessId(req),
      afterState: { isActive: rule.isActive, multiplier: rule.multiplier },
    });
    return res.status(200).json({ success: true, data: rule });
  } catch (err) {
    return sendSafeError(res, err, "Unable to save the earning rule.");
  }
}

const tierSchema = z.object({
  name: z.string().trim().min(1).max(60),
  minSpend: z.number().min(0).max(1_000_000_000),
  qualificationMonths: z.number().int().positive().max(1200).nullable().optional(),
  earnMultiplier: z.number().min(0).max(100),
  rank: z.number().int().min(0).max(1000),
  isActive: z.boolean(),
});

export async function getTiers(req: Request, res: Response) {
  try {
    const data = await loyaltyService.listTiers(getBusinessId(req));
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendSafeError(res, err, "Unable to read loyalty tiers.");
  }
}

export async function postTier(req: Request, res: Response) {
  try {
    const parsed = tierSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid loyalty tier.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await loyaltyService.createTier(getBusinessId(req), {
      name: parsed.data.name,
      minSpend: parsed.data.minSpend,
      qualificationMonths: parsed.data.qualificationMonths ?? null,
      earnMultiplier: parsed.data.earnMultiplier,
      rank: parsed.data.rank,
      isActive: parsed.data.isActive,
    });
    return res.status(201).json({ success: true, data });
  } catch (err) {
    return sendSafeError(res, err, "Unable to create the loyalty tier.");
  }
}

export async function putTier(req: Request, res: Response) {
  try {
    const tierId = Number(req.params.tierId);
    if (!Number.isInteger(tierId) || tierId <= 0) {
      throw new BadRequestError("Invalid tier ID.");
    }
    const parsed = tierSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid loyalty tier.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await loyaltyService.updateTier(getBusinessId(req), tierId, {
      name: parsed.data.name,
      minSpend: parsed.data.minSpend,
      qualificationMonths: parsed.data.qualificationMonths ?? null,
      earnMultiplier: parsed.data.earnMultiplier,
      rank: parsed.data.rank,
      isActive: parsed.data.isActive,
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendSafeError(res, err, "Unable to update the loyalty tier.");
  }
}

export async function deleteTier(req: Request, res: Response) {
  try {
    const tierId = Number(req.params.tierId);
    if (!Number.isInteger(tierId) || tierId <= 0) {
      throw new BadRequestError("Invalid tier ID.");
    }
    const data = await loyaltyService.deleteTier(getBusinessId(req), tierId);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendSafeError(res, err, "Unable to delete the loyalty tier.");
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
    const [overview, history] = await Promise.all([
      loyaltyService.getLoyaltyOverview(getBusinessId(req), customerId),
      loyaltyService.getLoyaltyHistory(getBusinessId(req), customerId),
    ]);
    return res
      .status(200)
      .json({ success: true, data: { ...overview, history } });
  } catch (err) {
    return sendSafeError(res, err, "Unable to read the loyalty account.");
  }
}

const adjustSchema = z.object({
  points: z.number().refine((v) => v !== 0, "Adjustment cannot be zero."),
  reason: z.string().trim().min(3).max(500),
});

/** Manual balance correction — loyalty.adjust, reason mandatory, audited. */
export async function postAdjust(req: Request, res: Response) {
  try {
    const customerId = Number(req.params.customerId);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid customer ID." });
    }
    const parsed = adjustSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid adjustment.",
        errors: parsed.error.flatten(),
      });
    }
    const businessId = getBusinessId(req);
    const actorUserId = req.user!.id;
    const result = await db.transaction(async (tx) => {
      const points = await loyaltyService.adjustLoyaltyPointsInTx(tx, {
        businessId,
        customerId,
        points: parsed.data.points,
        reason: parsed.data.reason,
        actorUserId,
      });
      await recordAuditInTxWrapper(tx, {
        businessId,
        actorUserId,
        customerId,
        points,
        reason: parsed.data.reason,
      });
      const overview = await loyaltyService.getLoyaltyOverview(businessId, customerId);
      return { points, overview };
    });
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to adjust the loyalty balance.");
  }
}

// Small local wrapper to keep recordAuditInTx imports tidy.
import { recordAuditInTx } from "../../services/audit.js";
import type { DbTransaction } from "../purchases/purchase.types.js";
async function recordAuditInTxWrapper(
  tx: DbTransaction,
  input: {
    businessId: number;
    actorUserId: number;
    customerId: number;
    points: number;
    reason: string;
  },
): Promise<void> {
  await recordAuditInTx(tx, {
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    action: "loyalty.adjusted",
    entityType: "customer",
    entityId: input.customerId,
    metadata: { points: input.points, reason: input.reason },
  });
}
