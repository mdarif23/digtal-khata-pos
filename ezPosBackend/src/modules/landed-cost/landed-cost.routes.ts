import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import {
  requirePermission,
  requireAnyPermission,
} from "../../middleware/permissions.js";
import * as landedCostController from "./landed-cost.controller.js";

const router = Router();

// Read chain: tenant-scoped, survives trial expiry (matches reports).
const read = [
  requireAuth,
  requireBusinessContext(),
  requirePermission("landed_cost.view"),
] as const;

// Preview runs the allocation engine but persists nothing — treat as read
// with the calculate permission honored too (viewers may recalculate).
const calculate = [
  requireAuth,
  requireBusinessContext(),
  requireAnyPermission(["landed_cost.view", "landed_cost.calculate"]),
  requireFullAccess,
] as const;

router.get(
  "/api/purchases/:purchaseId/landed-cost",
  ...read,
  landedCostController.getLandedCost,
);

router.post(
  "/api/purchases/:purchaseId/landed-cost",
  requireAuth,
  requireBusinessContext(),
  requirePermission("landed_cost.create"),
  requireFullAccess,
  landedCostController.createLandedCost,
);

router.get(
  "/api/landed-costs/:id",
  requireAuth,
  requireBusinessContext(),
  requirePermission("landed_cost.view"),
  landedCostController.getLandedCostDoc,
);

router.patch(
  "/api/landed-costs/:id",
  requireAuth,
  requireBusinessContext(),
  requirePermission("landed_cost.edit"),
  requireFullAccess,
  landedCostController.updateLandedCost,
);

// Estimated → actual expense adjustment (Phase 7). Financial — the
// landed-cost edit gate.
router.post(
  "/api/landed-costs/:id/adjust-expense",
  requireAuth,
  requireBusinessContext(),
  requireFullAccess,
  requirePermission("landed_cost.edit"),
  landedCostController.adjustExpense,
);
router.post(
  "/api/landed-costs/:id/post",
  requireAuth,
  requireBusinessContext(),
  requirePermission("landed_cost.post"),
  requireFullAccess,
  landedCostController.postLandedCost,
);

router.post(
  "/api/purchases/:purchaseId/landed-cost/preview",
  ...calculate,
  landedCostController.previewLandedCost,
);

export default router;
