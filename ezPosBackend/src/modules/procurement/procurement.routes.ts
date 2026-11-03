import express from "express";
import * as procurementController from "./procurement.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
// Price intelligence is purchase-derived analytics: same access chain as
// the purchases module. Reading price data requires purchases.view;
// recording/editing market observations requires purchases.price_check.
const read = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
] as const;
const write = [...read, requireFullAccess] as const;

router.get(
  "/api/procurement/price-overview",
  ...read,
  requirePermission("purchases.view"),
  procurementController.getPriceOverview,
);
router.get(
  "/api/procurement/variants/:variantId/price-history",
  ...read,
  requirePermission("purchases.view"),
  procurementController.getVariantPriceHistory,
);

// Quick Price Check — manual market quotations (never actual purchases).
router.post(
  "/api/procurement/price-check",
  ...write,
  requirePermission("purchases.price_check"),
  procurementController.createObservation,
);
router.get(
  "/api/procurement/price-check",
  ...read,
  requirePermission("purchases.view"),
  procurementController.listObservations,
);
router.patch(
  "/api/procurement/price-check/:id",
  ...write,
  requirePermission("purchases.price_check"),
  procurementController.updateObservation,
);
router.delete(
  "/api/procurement/price-check/:id",
  ...write,
  requirePermission("purchases.price_check"),
  procurementController.deleteObservation,
);
export default router;
