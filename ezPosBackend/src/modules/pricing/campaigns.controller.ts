import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import * as campaignsService from "./campaigns.service.js";
import {
  campaignCreateSchema,
  campaignUpdateSchema,
} from "./campaigns.validation.js";

/**
 * Promotional campaigns controller (Bundle & Combo Phase 4). Same
 * permission keys as promotions: reads promotions.view, writes
 * promotions.manage.
 */

function parseId(raw: string | string[] | undefined): number | null {
  if (Array.isArray(raw)) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function listCampaigns(req: Request, res: Response) {
  try {
    const rows = await campaignsService.listCampaigns(getBusinessId(req));
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    return sendSafeError(res, err, "Unable to list campaigns.");
  }
}

export async function getCampaign(req: Request, res: Response) {
  try {
    const id = parseId(req.params.id);
    if (id == null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const row = await campaignsService.getCampaign(getBusinessId(req), id);
    return res.status(200).json({ success: true, data: row });
  } catch (err) {
    return sendSafeError(res, err, "Unable to load the campaign.");
  }
}

export async function createCampaign(req: Request, res: Response) {
  try {
    const parsed = campaignCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid campaign.",
        errors: parsed.error.flatten(),
      });
    }
    const campaign = await campaignsService.createCampaign(
      getBusinessId(req),
      req.user!.id,
      parsed.data,
    );
    return res.status(201).json({ success: true, data: campaign });
  } catch (err) {
    return sendSafeError(res, err, "Unable to create the campaign.");
  }
}

export async function updateCampaign(req: Request, res: Response) {
  try {
    const id = parseId(req.params.id);
    if (id == null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const parsed = campaignUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid campaign update.",
        errors: parsed.error.flatten(),
      });
    }
    const campaign = await campaignsService.updateCampaign(
      getBusinessId(req),
      req.user!.id,
      id,
      parsed.data,
    );
    return res.status(200).json({ success: true, data: campaign });
  } catch (err) {
    return sendSafeError(res, err, "Unable to update the campaign.");
  }
}

export async function deleteCampaign(req: Request, res: Response) {
  try {
    const id = parseId(req.params.id);
    if (id == null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const deleted = await campaignsService.deleteCampaign(getBusinessId(req), id);
    return res.status(200).json({ success: true, data: deleted });
  } catch (err) {
    return sendSafeError(res, err, "Unable to delete the campaign.");
  }
}
