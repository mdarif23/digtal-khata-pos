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

router.get(
  "/api/coupons",
  ...read,
  requirePermission("promotions.view"),
  promotionsController.listCoupons,
);
router.post(
  "/api/coupons",
  ...write,
  requirePermission("promotions.manage"),
  promotionsController.createCoupon,
);
router.patch(
  "/api/coupons/:id",
  ...write,
  requirePermission("promotions.manage"),
  promotionsController.updateCoupon,
);

export default router;
