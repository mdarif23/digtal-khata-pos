import express from "express";
import * as campaignsController from "./campaigns.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
const read = [requireAuth, requireBusinessContext()] as const;
const write = [...read, requireFullAccess] as const;

// Promotional campaigns (Bundle & Combo Phase 4): CRUD reuses the
// promotions permission keys — campaigns gate promotions, they are managed
// by the same staff.
router.get(
  "/api/campaigns",
  ...read,
  requirePermission("promotions.view"),
  campaignsController.listCampaigns,
);
router.get(
  "/api/campaigns/:id",
  ...read,
  requirePermission("promotions.view"),
  campaignsController.getCampaign,
);
router.post(
  "/api/campaigns",
  ...write,
  requirePermission("promotions.manage"),
  campaignsController.createCampaign,
);
router.patch(
  "/api/campaigns/:id",
  ...write,
  requirePermission("promotions.manage"),
  campaignsController.updateCampaign,
);
router.delete(
  "/api/campaigns/:id",
  ...write,
  requirePermission("promotions.manage"),
  campaignsController.deleteCampaign,
);

export default router;
