import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import * as promotionsService from "./promotions.service.js";
import {
  promotionCreateSchema,
  promotionUpdateSchema,
} from "./promotions.validation.js";

/**
 * Auto-applied promotions controller (Phase 5). Writes reuse
 * promotions.manage; reads promotions.view (same catalog keys as coupons).
 */

function parseId(raw: string | string[] | undefined): number | null {
  if (Array.isArray(raw)) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function listPromotions(req: Request, res: Response) {
  try {
    const rows = await promotionsService.listPromotions(getBusinessId(req));
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    return sendSafeError(res, err, "Unable to list promotions.");
  }
}

export async function getPromotion(req: Request, res: Response) {
  try {
    const id = parseId(req.params.id);
    if (id == null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const row = await promotionsService.getPromotion(getBusinessId(req), id);
    return res.status(200).json({ success: true, data: row });
  } catch (err) {
    return sendSafeError(res, err, "Unable to load the promotion.");
  }
}

export async function createPromotion(req: Request, res: Response) {
  try {
    const parsed = promotionCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid promotion.",
        errors: parsed.error.flatten(),
      });
    }
    const promotion = await promotionsService.createPromotion(
      getBusinessId(req),
      req.user!.id,
      parsed.data,
    );
    return res.status(201).json({ success: true, data: promotion });
  } catch (err) {
    return sendSafeError(res, err, "Unable to create the promotion.");
  }
}

export async function updatePromotion(req: Request, res: Response) {
  try {
    const id = parseId(req.params.id);
    if (id == null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const parsed = promotionUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid promotion update.",
        errors: parsed.error.flatten(),
      });
    }
    const promotion = await promotionsService.updatePromotion(
      getBusinessId(req),
      req.user!.id,
      id,
      parsed.data,
    );
    return res.status(200).json({ success: true, data: promotion });
  } catch (err) {
    return sendSafeError(res, err, "Unable to update the promotion.");
  }
}

export async function deletePromotion(req: Request, res: Response) {
  try {
    const id = parseId(req.params.id);
    if (id == null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const deleted = await promotionsService.deletePromotion(getBusinessId(req), id);
    return res.status(200).json({ success: true, data: deleted });
  } catch (err) {
    return sendSafeError(res, err, "Unable to delete the promotion.");
  }
}
