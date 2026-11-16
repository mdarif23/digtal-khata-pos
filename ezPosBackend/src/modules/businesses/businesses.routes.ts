import express from "express";
import * as businessesController from "./businesses.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessAccess,
  requireFullAccess,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";
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

// PUT /api/businesses/:businessId   (auth + membership + full access +
// settings.edit) — business profile and operating-model changes are settings
// decisions, not something every member may make (security fix: this route
// previously required membership only).
// State-changing: blocked with 403 TRIAL_EXPIRED / SUBSCRIPTION_REQUIRED in
// read-only mode. For mode switches available in read-only mode use the
// dedicated PATCH /mode route below.
router.put(
  "/api/businesses/:businessId",
  requireAuth,
  requireBusinessAccess(),
  requireFullAccess,
  requirePermission("settings.edit"),
  businessesController.updateBusiness,
);

// PATCH /api/businesses/:businessId/mode   (auth + membership + settings.edit)
// Operating-model switch (physical_only | online_only | omnichannel).
// Deliberately reachable WITHOUT requireFullAccess: the mode is
// configuration, not data, so a read-only (expired-trial) tenant may still
// switch it while every other write stays blocked.
// Body: { mode }. 200 -> { success, business }
router.patch(
  "/api/businesses/:businessId/mode",
  requireAuth,
  requireBusinessAccess(),
  requirePermission("settings.edit"),
  businessesController.changeBusinessMode,
);

// GET /api/businesses/:businessId/operations   (auth + membership; read-only OK)
// Settings → Business Operations snapshot: current mode, per-channel setup
// counts and readiness flags. Read-only by design — no side effects.
// 200 -> { success, operations: { mode, subscription, counts, readiness } }
router.get(
  "/api/businesses/:businessId/operations",
  requireAuth,
  requireBusinessAccess(),
  businessesController.getBusinessOperations,
);

// PUT /api/businesses/:businessId/logo   (auth + membership + full access +
// receipt_settings.manage_logo) — receipt/invoice branding. Body:
// { dataUrl: "data:image/png;base64,..." } validated (type allow-list,
// magic bytes, 300 KB cap) in the service.
router.put(
  "/api/businesses/:businessId/logo",
  requireAuth,
  requireBusinessAccess(),
  requireFullAccess,
  requirePermission("receipt_settings.manage_logo"),
  businessesController.setBusinessLogo,
);

// DELETE /api/businesses/:businessId/logo   (same chain) — clears the logo.
router.delete(
  "/api/businesses/:businessId/logo",
  requireAuth,
  requireBusinessAccess(),
  requireFullAccess,
  requirePermission("receipt_settings.manage_logo"),
  businessesController.removeBusinessLogo,
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
