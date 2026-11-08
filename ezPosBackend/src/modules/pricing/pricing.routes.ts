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

export default router;
