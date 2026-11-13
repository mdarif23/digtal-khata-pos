import express from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import {
  getBusinessId,
  requireBusinessContext,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { getTerminalId } from "../../middleware/terminalContext.js";
import { callerHasPermission, requirePermission } from "../../middleware/permissions.js";
import { sendSafeError } from "../../utils/safeError.js";
import { BadRequestError } from "../../utils/handleError.js";
import {
  resolveLayout,
  saveLayout,
  type ScopeType,
} from "./speedKeys.service.js";

const router = express.Router();

const tileSchema = z.object({
  variantId: z.number().int().positive(),
  label: z.string().trim().min(1).max(40),
  color: z.enum(["slate", "blue", "green", "amber", "red", "purple", "teal"]),
  sortOrder: z.number().int().min(0),
});

const putSchema = z.object({
  scopeType: z.enum(["business", "user", "register"]),
  /** Register id when scopeType=register; ignored otherwise. */
  scopeId: z.number().int().min(0).optional(),
  tiles: z.array(tileSchema).max(60),
});

const read = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
] as const;

/** The most specific layout for the caller (user > register > business). */
router.get("/api/speed-keys", ...read, async (req: Request, res: Response) => {
  try {
    const registerId = getTerminalId(req);
    const tiles = await resolveLayout(getBusinessId(req), req.user!.id, registerId);
    return res.status(200).json({ success: true, data: tiles });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the speed-key layout.");
  }
});

router.put("/api/speed-keys", ...read, async (req: Request, res: Response) => {
  try {
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid speed-key layout.",
        errors: parsed.error.flatten(),
      });
    }
    const businessId = getBusinessId(req);
    const userId = req.user!.id;
    let scopeType = parsed.data.scopeType as ScopeType;
    let scopeId = 0;
    if (scopeType === "user") {
      scopeId = userId;
    } else if (scopeType === "register") {
      const terminalId = getTerminalId(req);
      if (terminalId === null) {
        throw new BadRequestError(
          "Register-scoped layouts require a bound terminal (X-Terminal-Id).",
        );
      }
      scopeId = terminalId;
    } else if (!callerHasPermission(req, "settings.edit")) {
      return res
        .status(403)
        .json({ success: false, message: "Missing settings.edit." });
    }
    const tiles = await saveLayout(businessId, userId, scopeType, scopeId, parsed.data.tiles);
    return res.status(200).json({ success: true, data: tiles });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to save the speed-key layout.");
  }
});

export default router;
