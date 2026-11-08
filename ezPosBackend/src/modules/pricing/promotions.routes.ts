import express from "express";
import * as promotionsController from "./promotions.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
const read = [requireAuth, requireBusinessContext()] as const;
const write = [...read, requireFullAccess] as const;

// Auto-applied promotions (Phase 5, approved §14): CRUD reuses the coupons
// permission keys (promotions.view / promotions.manage). The coupon API
// (modules/promotions → /api/coupons) is untouched.
router.get(
  "/api/promotions",
  ...read,
  requirePermission("promotions.view"),
  promotionsController.listPromotions,
);
router.get(
  "/api/promotions/:id",
  ...read,
  requirePermission("promotions.view"),
  promotionsController.getPromotion,
);
router.post(
  "/api/promotions",
  ...write,
  requirePermission("promotions.manage"),
  promotionsController.createPromotion,
);
router.patch(
  "/api/promotions/:id",
  ...write,
  requirePermission("promotions.manage"),
  promotionsController.updatePromotion,
);
router.delete(
  "/api/promotions/:id",
  ...write,
  requirePermission("promotions.manage"),
  promotionsController.deletePromotion,
);

export default router;
