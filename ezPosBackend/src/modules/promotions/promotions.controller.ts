import type { Request, Response } from "express";
import { z } from "zod";
import * as couponsService from "../../services/coupons.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

const couponPayloadSchema = z.object({
  code: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  discountType: z.enum(["percentage", "fixed"]),
  value: z.number().min(0),
  minOrderAmount: z.number().min(0).nullable().optional(),
  maxDiscountAmount: z.number().min(0).nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  usageLimit: z.number().int().min(0).nullable().optional(),
  perCustomerLimit: z.number().int().min(0).nullable().optional(),
  isActive: z.boolean().optional(),
});

const couponUpdateSchema = couponPayloadSchema.partial().omit({ code: true });

export async function listCoupons(req: Request, res: Response) {
  try {
    const rows = await couponsService.listCoupons(getBusinessId(req));
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    return sendSafeError(res, err, "Unable to list coupons.");
  }
}

export async function createCoupon(req: Request, res: Response) {
  try {
    const parsed = couponPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid coupon data.",
        errors: parsed.error.flatten(),
      });
    }
    const coupon = await couponsService.createCoupon(getBusinessId(req), parsed.data);
    return res.status(201).json({ success: true, data: coupon });
  } catch (err) {
    return sendSafeError(res, err, "Unable to create the coupon.");
  }
}

export async function updateCoupon(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const parsed = couponUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid coupon data.",
        errors: parsed.error.flatten(),
      });
    }
    const coupon = await couponsService.updateCoupon(getBusinessId(req), id, parsed.data);
    return res.status(200).json({ success: true, data: coupon });
  } catch (err) {
    return sendSafeError(res, err, "Unable to update the coupon.");
  }
}
