import express from "express";
import * as salesController from "./sales.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
// Location-aware: the X-Location-Id header (or the business default) is
// validated against membership + assignment before any handler runs.
const read = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
] as const;
const write = [...read, requireFullAccess] as const;

router.get(
  "/api/sold_products",
  ...read,
  requirePermission("sales.view"),
  salesController.getSalesData,
);
router.post(
  "/api/sales",
  ...write,
  requirePermission("pos.create_sale"),
  salesController.createSale,
);
router.get(
  "/api/sales/:id/receipt",
  ...read,
  requirePermission("sales.view"),
  salesController.getSaleReceipt,
);
// Refund endpoints are POST (state-changing) — full access required.
router.post(
  "/api/sold_products/refund/:id",
  ...write,
  requirePermission("sales.return"),
  salesController.createSingleRefund,
);
router.post(
  "/api/sold_products/refunds_all/:id",
  ...write,
  requirePermission("sales.return"),
  salesController.createMultipleRefunds,
);
router.get(
  "/api/dashboard_summary",
  ...read,
  requirePermission("dashboard.view"),
  salesController.getDashboardSummary,
);
router.get(
  "/api/variants/:variantId/serials",
  ...read,
  requirePermission("inventory.view"),
  salesController.getAvailableSerials,
);
router.patch(
  "/api/variants/:variantId/serials",
  ...write,
  requirePermission("sales.edit"),
  salesController.updateAvailableSerial,
);
export default router;
