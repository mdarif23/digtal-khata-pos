import express from "express";
import * as pricingController from "./pricing.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
// Read chain: authenticated + verified owner membership + tenant context.
// Location-aware: the X-Location-Id header scopes per-location cost reads.
const read = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
] as const;
// State-changing chain additionally requires full subscription access.
const write = [...read, requireFullAccess] as const;

router.get(
  "/api/pricing/settings",
  ...read,
  requirePermission("pricing.view"),
  pricingController.getPricingSettings,
);
router.put(
  "/api/pricing/settings",
  ...write,
  requirePermission("pricing.manage"),
  pricingController.putPricingSettings,
);
// Price preview: read-only computation, never persists (report §0/§14).
router.post(
  "/api/pricing/preview",
  ...read,
  requirePermission("pricing.view"),
  pricingController.postPreview,
);

// --- Rules (Phase 2) --------------------------------------------------------
router.get(
  "/api/pricing/rules",
  ...read,
  requirePermission("pricing.view"),
  pricingController.listRules,
);
router.post(
  "/api/pricing/rules",
  ...write,
  requirePermission("pricing.manage"),
  pricingController.createRule,
);
router.patch(
  "/api/pricing/rules/:id",
  ...write,
  requirePermission("pricing.manage"),
  pricingController.patchRule,
);
router.delete(
  "/api/pricing/rules/:id",
  ...write,
  requirePermission("pricing.manage"),
  pricingController.deleteRule,
);

// --- Effective pricing + materialization (Phase 2) --------------------------
router.get(
  "/api/pricing/products/:variantId/price",
  ...read,
  requirePermission("pricing.view"),
  pricingController.getVariantPricing,
);
// THE pricing-module write path for the effective selling price (rule_apply
// + history + audit). Manual price edits stay on the product module.
router.put(
  "/api/pricing/products/:variantId/price",
  ...write,
  requirePermission("pricing.product.manage"),
  pricingController.applyVariantPrice,
);

// --- Price history (Phase 2) -------------------------------------------------
router.get(
  "/api/pricing/history",
  ...read,
  requirePermission("pricing.history.view"),
  pricingController.listPriceHistory,
);

export default router;
