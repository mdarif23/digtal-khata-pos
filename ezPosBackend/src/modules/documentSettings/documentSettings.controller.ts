import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import { BadRequestError } from "../../utils/handleError.js";
import {
  isDocumentType,
  updateDocumentSettingsSchema,
} from "./documentSettings.schemas.js";
import {
  getDocumentSettings,
  saveDocumentSettings,
} from "./documentSettings.service.js";

/**
 * GET /api/document-settings
 * Both document templates merged over versioned defaults. Read is open to
 * anyone who can already see sales/POS — cashiers need the active template
 * to print, customization is gated separately on the PUT.
 */
export async function getDocumentSettingsController(req: Request, res: Response) {
  try {
    const data = await getDocumentSettings(getBusinessId(req));
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendSafeError(
      res,
      err,
      "Unable to load document settings right now.",
    );
  }
}

/**
 * PUT /api/document-settings/:docType
 * Body: { config: <full template config> } — replaced wholesale (templates
 * are small; partial patching would make "reset to defaults" ambiguous).
 */
export async function updateDocumentSettingsController(
  req: Request,
  res: Response,
) {
  try {
    const docType = String(req.params.docType ?? "");
    if (!isDocumentType(docType)) {
      throw new BadRequestError("Unknown document type.");
    }
    const parsed = updateDocumentSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid document settings payload.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await saveDocumentSettings(
      getBusinessId(req),
      docType,
      parsed.data.config,
    );
    return res.status(200).json({
      success: true,
      message: "Document settings saved.",
      data,
    });
  } catch (err) {
    return sendSafeError(
      res,
      err,
      "Unable to save document settings right now.",
    );
  }
}
