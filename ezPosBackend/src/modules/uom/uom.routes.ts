import express from "express";
import * as uomController from "./uom.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
// Location-aware like the rest of the product module: the X-Location-Id
// header (or the business default) is validated before any handler runs.
const read = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
] as const;
const write = [...read, requireFullAccess] as const;

// Configuration (Units & Packaging section of the product form)
router.get(
  "/api/product/:productId/uom",
  ...read,
  requirePermission("products.view"),
  uomController.getProductUom,
);
router.post(
  "/api/product/:productId/uom",
  ...write,
  requirePermission("products.edit"),
  uomController.createProductUom,
);
router.patch(
  "/api/product/uom/:conversionId",
  ...write,
  requirePermission("products.edit"),
  uomController.updateProductUom,
);
router.post(
  "/api/product/uom/:conversionId/deactivate",
  ...write,
  requirePermission("products.edit"),
  uomController.deactivateProductUom,
);

// Unit pickers (POS / purchasing)
router.get(
  "/api/variant/:variantId/sell-units",
  ...read,
  requirePermission("sales.view"),
  uomController.getVariantSellUnits,
);
router.get(
  "/api/variant/:variantId/purchase-units",
  ...read,
  requirePermission("products.view"),
  uomController.getVariantPurchaseUnits,
);

// Server-authoritative conversion preview (quote/checkout support)
router.post(
  "/api/uom/resolve",
  ...read,
  requirePermission("products.view"),
  uomController.resolveUom,
);

export default router;
