import express from "express";
import * as stockCountController from "./stockCount.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";

/**
 * Stock-count sessions (Module 2): barcode stocktaking + cycle counting.
 * Counting and approval both require inventory.adjust — the same power as
 * applying a manual adjustment; the audit trail separates counted_by from
 * approved_by.
 */
const router = express.Router();

const write = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
  requireFullAccess,
] as const;

router.get(
  "/api/stock-counts",
  ...write,
  requirePermission("inventory.adjust"),
  stockCountController.listSessions,
);
router.post(
  "/api/stock-counts",
  ...write,
  requirePermission("inventory.adjust"),
  stockCountController.createSession,
);
router.get(
  "/api/stock-counts/:id",
  ...write,
  requirePermission("inventory.adjust"),
  stockCountController.getSession,
);
router.post(
  "/api/stock-counts/:id/counts",
  ...write,
  requirePermission("inventory.adjust"),
  stockCountController.submitCount,
);
router.post(
  "/api/stock-counts/:id/approve",
  ...write,
  requirePermission("inventory.adjust"),
  stockCountController.approveSession,
);
router.post(
  "/api/stock-counts/:id/cancel",
  ...write,
  requirePermission("inventory.adjust"),
  stockCountController.cancelSession,
);

export default router;
