import type { Request, Response } from "express";
import { z } from "zod";
import * as reorderService from "./reorder.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { getLocationId } from "../../middleware/location.js";
import { sendSafeError } from "../../utils/safeError.js";

const configSchema = z.object({
  reorderPoint: z.number().int().min(0).nullable(),
  reorderQuantity: z.number().int().min(0).nullable(),
});

const convertSchema = z.object({
  supplierId: z.number().int().positive().nullable(),
  note: z.string().trim().max(300).optional(),
  items: z
    .array(
      z.object({
        variantId: z.number().int().positive(),
        quantity: z.number().positive().optional(),
      }),
    )
    .min(1)
    .max(200),
});

export async function getReorderConfig(req: Request, res: Response) {
  try {
    const variantId = Number(req.params.variantId);
    if (!Number.isInteger(variantId) || variantId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid variant ID." });
    }
    const rows = await reorderService.getVariantReorderConfig(
      getBusinessId(req),
      variantId,
    );
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    return sendSafeError(res, err, "Unable to read the reorder config.");
  }
}

export async function setReorderConfig(req: Request, res: Response) {
  try {
    const variantId = Number(req.params.variantId);
    if (!Number.isInteger(variantId) || variantId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid variant ID." });
    }
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid reorder configuration.",
        errors: parsed.error.flatten(),
      });
    }
    const result = await reorderService.setReorderConfig(
      getBusinessId(req),
      variantId,
      req.user?.id ?? null,
      parsed.data,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to save the reorder config.");
  }
}

export async function getSuggestions(req: Request, res: Response) {
  try {
    const suggestions = await reorderService.listReorderSuggestions(
      getBusinessId(req),
      getLocationId(req),
    );
    return res.status(200).json({ success: true, data: suggestions });
  } catch (err) {
    return sendSafeError(res, err, "Unable to list reorder suggestions.");
  }
}

export async function convertToPurchase(req: Request, res: Response) {
  try {
    const parsed = convertSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversion data.",
        errors: parsed.error.flatten(),
      });
    }
    const purchase = await reorderService.convertSuggestionsToPurchase(
      getBusinessId(req),
      getLocationId(req),
      req.user?.id ?? null,
      parsed.data,
    );
    return res.status(201).json({ success: true, data: purchase });
  } catch (err) {
    return sendSafeError(res, err, "Unable to create the purchase order.");
  }
}

/** Phase 4 (Feature 14): lead-time upsert per variant+supplier. */
export async function setLeadTime(req: Request, res: Response) {
  try {
    const schema = z.object({
      variantId: z.number().int().positive(),
      supplierId: z.number().int().positive(),
      leadTimeDays: z.number().int().min(0).max(365),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid lead time.",
        errors: parsed.error.flatten(),
      });
    }
    await reorderService.setLeadTime(getBusinessId(req), parsed.data);
    return res.status(200).json({ success: true });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to save the lead time.");
  }
}

export async function getLeadTimes(req: Request, res: Response) {
  try {
    const variantId = Number(req.query.variantId);
    if (!Number.isInteger(variantId) || variantId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid variant ID." });
    }
    const data = await reorderService.getLeadTime(getBusinessId(req), variantId);
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load lead times.");
  }
}
