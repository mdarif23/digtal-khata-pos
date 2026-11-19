import type { Request, Response } from "express";
import { z } from "zod";
import * as couponsService from "../../services/coupons.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import { getBusinessTimezone } from "../../services/ledger.js";
import { businessLocalToUtcWall } from "../../utils/money.js";
import { db } from "../../db/schema/index.js";

// I3-6: boundaries accept a bare 'YYYY-MM-DD' (business-calendar day
// bounds) alongside full ISO timestamps.
const couponDateBound = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  z.string().datetime(),
]);

const couponPayloadSchema = z.object({
  code: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  discountType: z.enum(["percentage", "fixed"]),
  value: z.number().min(0),
  minOrderAmount: z.number().min(0).nullable().optional(),
  maxDiscountAmount: z.number().min(0).nullable().optional(),
  startsAt: couponDateBound.nullable().optional(),
  endsAt: couponDateBound.nullable().optional(),
  usageLimit: z.number().int().min(0).nullable().optional(),
  perCustomerLimit: z.number().int().min(0).nullable().optional(),
  isActive: z.boolean().optional(),
});

const couponUpdateSchema = couponPayloadSchema.partial().omit({ code: true });

type CouponDateBound = z.infer<typeof couponDateBound>;

/** I3-6: date-only → business-calendar instant (start or end of day). */
async function resolveCouponBound(
  businessId: number,
  value: CouponDateBound | null | undefined,
  boundary: "start" | "end",
): Promise<string | null | undefined> {
  if (value == null) return value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const tz = await getBusinessTimezone(db, businessId);
  const wall = businessLocalToUtcWall(
    value,
    boundary === "start" ? "00:00:00" : "23:59:59.999",
    tz,
  );
  return `${wall.replace(" ", "T")}Z`;
}

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
    const coupon = await couponsService.createCoupon(getBusinessId(req), {
      ...parsed.data,
      startsAt: await resolveCouponBound(
        getBusinessId(req),
        parsed.data.startsAt,
        "start",
      ),
      endsAt: await resolveCouponBound(
        getBusinessId(req),
        parsed.data.endsAt,
        "end",
      ),
    });
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
    const coupon = await couponsService.updateCoupon(getBusinessId(req), id, {
      ...parsed.data,
      startsAt: await resolveCouponBound(
        getBusinessId(req),
        parsed.data.startsAt,
        "start",
      ),
      endsAt: await resolveCouponBound(
        getBusinessId(req),
        parsed.data.endsAt,
        "end",
      ),
    });
    return res.status(200).json({ success: true, data: coupon });
  } catch (err) {
    return sendSafeError(res, err, "Unable to update the coupon.");
  }
}
