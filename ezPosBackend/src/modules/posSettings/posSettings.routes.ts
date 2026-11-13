import express from "express";
import { z } from "zod";
import type { Request, Response } from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import {
  getPosSettings,
  updatePosSettings,
} from "./posSettings.service.js";

const router = express.Router();

const read = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
] as const;
// Changing checkout policy is a business-settings decision, not a
// location-level one — settings.edit + full access, like register management.
const manage = [
  ...read,
  requireFullAccess,
  requirePermission("settings.edit"),
] as const;

const approvalRequiredSchema = z
  .object({
    sale_refund: z.boolean().optional(),
    cash_movement: z.boolean().optional(),
    below_minimum_price: z.boolean().optional(),
  })
  .strict();

const embeddedBarcodeSchema = z
  .object({
    prefixes: z.array(z.string().regex(/^\d{1,3}$/)).min(1).max(5),
    pluLength: z.number().int().min(1).max(12),
    valueLength: z.number().int().min(1).max(12),
    decimals: z.number().int().min(0).max(6),
    mode: z.enum(["weight", "price"]),
    hasCheckDigit: z.boolean(),
  })
  .strict();

const patchSchema = z
  .object({
    requireTerminal: z.boolean().optional(),
    allowMultipleDrawerSessions: z.boolean().optional(),
    requireOpenDrawer: z.boolean().optional(),
    approvalRequired: approvalRequiredSchema.optional(),
    embeddedBarcode: embeddedBarcodeSchema.nullable().optional(),
  })
  .refine(
    (v) =>
      v.requireTerminal !== undefined ||
      v.allowMultipleDrawerSessions !== undefined ||
      v.requireOpenDrawer !== undefined ||
      v.approvalRequired !== undefined ||
      v.embeddedBarcode !== undefined,
    { message: "Nothing to update." },
  );

router.get("/api/pos-settings", ...read, async (req: Request, res: Response) => {
  try {
    const settings = await getPosSettings(getBusinessId(req));
    res.status(200).json({ data: settings });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load POS settings.");
  }
});

router.patch(
  "/api/pos-settings",
  ...manage,
  async (req: Request, res: Response) => {
    try {
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: "Invalid POS settings.",
          errors: parsed.error.flatten(),
        });
      }
      const settings = await updatePosSettings(getBusinessId(req), parsed.data);
      res.status(200).json({ data: settings });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to update POS settings.");
    }
  },
);

export default router;
