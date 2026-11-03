import express from "express";
import * as businessesController from "./businesses.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessAccess,
  requireFullAccess,
} from "../../middleware/business.js";
import { authRateLimit } from "../../middleware/rateLimit.js";

const router = express.Router();

// POST /api/businesses   (Authorization: Bearer <accessToken>)
// Body: { name, phone?, email?, address? }
// Creates the business, the per-business "owner" role, an active owner
// membership for the caller, and (once the trial plan row is seeded) a
// 14-day trialing subscription — all in one transaction.
// 201 -> { success, message, business, ownerRoleSlug, subscription, trialSkipped }
router.post(
  "/api/businesses",
  requireAuth,
  authRateLimit,
  businessesController.createBusiness,
);

// GET /api/businesses/:businessId   (auth + active membership)
// 200 -> { success, business: { ..., subscription, roleSlug } }
// 403 when the user is not an active member of that business.
router.get(
  "/api/businesses/:businessId",
  requireAuth,
  requireBusinessAccess(),
  businessesController.getBusiness,
);

// PUT /api/businesses/:businessId   (auth + membership + full access)
// State-changing: blocked with 403 TRIAL_EXPIRED / SUBSCRIPTION_REQUIRED in
// read-only mode.
router.put(
  "/api/businesses/:businessId",
  requireAuth,
  requireBusinessAccess(),
  requireFullAccess,
  businessesController.updateBusiness,
);

// GET /api/businesses/:businessId/subscription   (auth + membership)
// Read-only: available even after trial expiry, so the client can show
// plan selection.
// 200 -> { success, subscription: { status, accessMode, trial, currentPeriodEnd } }
router.get(
  "/api/businesses/:businessId/subscription",
  requireAuth,
  requireBusinessAccess(),
  businessesController.getBusinessSubscription,
);

export default router;

// DELETE /api/businesses/:businessId   (auth + active membership; OWNER only)
// Soft-delete: business -> inactive, open subscription -> canceled, all
// memberships -> suspended. Available regardless of subscription access
// mode so an owner can always close a business.
// 200 -> { success, message }
router.delete(
  "/api/businesses/:businessId",
  requireAuth,
  requireBusinessAccess(),
  businessesController.deleteBusiness,
);
