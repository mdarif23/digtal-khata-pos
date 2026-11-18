import express from "express";
import * as v1c from "./storefront.v1.controller.js";
import * as keysC from "./storefront.keys.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessAccess,
  requireFullAccess,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";
import {
  authenticateStorefrontKey,
  requireBusinessMode,
  requireStorefrontScope,
} from "../../middleware/storefront.js";

/**
 * Storefront surfaces (Phase 9.2).
 *
 * /api/v1/storefront/* — public API for customer storefronts, authenticated
 * by API keys (not user sessions). All routes require an online-capable
 * business mode; catalog reads need the publishable or secret key, order
 * submission requires the secret key with the orders:write scope.
 *
 * /api/businesses/:businessId/storefront/keys — portal management of keys
 * (business-member authenticated, full access required).
 */
const router = express.Router();

const keyAuth = [authenticateStorefrontKey] as const;

router.get(
  "/api/v1/storefront/products",
  ...keyAuth,
  requireBusinessMode("online_only", "omnichannel"),
  requireStorefrontScope("products:read"),
  v1c.getProducts,
);
router.get(
  "/api/v1/storefront/products/:productId",
  ...keyAuth,
  requireBusinessMode("online_only", "omnichannel"),
  requireStorefrontScope("products:read"),
  v1c.getProductDetail,
);
router.get(
  "/api/v1/storefront/categories",
  ...keyAuth,
  requireBusinessMode("online_only", "omnichannel"),
  requireStorefrontScope("products:read"),
  v1c.getCategories,
);
router.get(
  "/api/v1/storefront/brands",
  ...keyAuth,
  requireBusinessMode("online_only", "omnichannel"),
  requireStorefrontScope("products:read"),
  v1c.getBrands,
);
router.get(
  "/api/v1/storefront/inventory",
  ...keyAuth,
  requireBusinessMode("online_only", "omnichannel"),
  requireStorefrontScope("inventory:read"),
  v1c.getAvailability,
);
router.post(
  "/api/v1/storefront/orders",
  ...keyAuth,
  requireBusinessMode("online_only", "omnichannel"),
  requireStorefrontScope("orders:write"),
  v1c.createOrder,
);
router.get(
  "/api/v1/storefront/orders/:orderId",
  ...keyAuth,
  requireBusinessMode("online_only", "omnichannel"),
  requireStorefrontScope("orders:read"),
  v1c.getOrderStatus,
);

// Portal key management.
// K3-002: minting `ezpos_sk_` secret keys (one-time secret, orders:write)
// was reachable by ANY active member — storefront.manage is the authority
// (catalog keys exist for it).
const portal = [
  requireAuth,
  requireBusinessAccess(),
  requireFullAccess,
  requirePermission("storefront.manage"),
] as const;
router.post(
  "/api/businesses/:businessId/storefront/keys",
  ...portal,
  keysC.createKey,
);
router.get(
  "/api/businesses/:businessId/storefront/keys",
  ...portal,
  keysC.listKeys,
);
router.post(
  "/api/businesses/:businessId/storefront/keys/:keyId/revoke",
  ...portal,
  keysC.revokeKey,
);

export default router;
