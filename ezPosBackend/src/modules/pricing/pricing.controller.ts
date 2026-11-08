import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { getLocationId } from "../../middleware/location.js";
import { callerHasPermission } from "../../middleware/permissions.js";
import { sendSafeError } from "../../utils/safeError.js";
import * as pricingService from "./pricing.service.js";
import {
  pricingPreviewSchema,
  pricingSettingsUpdateSchema,
} from "./pricing.validation.js";

/**
 * Pricing module controller (Phase 1: settings + preview). Cost fields in
 * preview responses are stripped for callers without products.view_cost —
 * same contract as the product catalog (rbac/sanitize.ts).
 */

export async function getPricingSettings(req: Request, res: Response) {
  try {
    const settings = await pricingService.getPricingSettingsView(
      getBusinessId(req),
    );
    return res.status(200).json({ success: true, data: settings });
  } catch (err) {
    return sendSafeError(res, err, "Unable to load pricing settings.");
  }
}

export async function putPricingSettings(req: Request, res: Response) {
  try {
    const parsed = pricingSettingsUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid pricing settings.",
        errors: parsed.error.flatten(),
      });
    }
    const settings = await pricingService.upsertPricingSettings(
      getBusinessId(req),
      parsed.data,
    );
    return res.status(200).json({ success: true, data: settings });
  } catch (err) {
    return sendSafeError(res, err, "Unable to save pricing settings.");
  }
}

export async function postPreview(req: Request, res: Response) {
  try {
    const parsed = pricingPreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid pricing preview request.",
        errors: parsed.error.flatten(),
      });
    }
    const rows = await pricingService.previewVariantPricing(
      getBusinessId(req),
      getLocationId(req),
      parsed.data,
    );
    // Cost visibility: pricing.view callers without products.view_cost never
    // see cost figures (same rule as the product catalog).
    const includeCost = callerHasPermission(req, "products.view_cost");
    const data = includeCost
      ? rows
      : rows.map((row) => ({ ...row, cost: null, costStatus: row.costStatus }));
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendSafeError(res, err, "Unable to calculate price previews.");
  }
}
