import express from "express";
import * as reorderController from "./reorder.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();

const read = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
] as const;
const write = [...read, requireFullAccess] as const;

router.get(
  "/api/reorder-suggestions",
  ...read,
  requirePermission("purchases.view"),
  reorderController.getSuggestions,
);
router.post(
  "/api/reorder-suggestions/convert",
  ...write,
  requirePermission("purchases.create"),
  reorderController.convertToPurchase,
);
router.get(
  "/api/variants/:variantId/reorder-config",
  ...read,
  requirePermission("products.view"),
  reorderController.getReorderConfig,
);
router.patch(
  "/api/variants/:variantId/reorder-config",
  ...write,
  requirePermission("products.edit"),
  reorderController.setReorderConfig,
);

export default router;
