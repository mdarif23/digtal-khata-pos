import express from "express";
import * as saleIntentsController from "./saleIntents.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";
import { ipnRateLimit } from "../../middleware/rateLimit.js";

/**
 * Electronic sale-payment intents. Manual payment rows (cash / card / QR
 * reference) remain on the regular sale endpoints — these routes are only
 * for provider-verified electronic payments.
 *
 * The IPN route is deliberately public: the gateway cannot authenticate,
 * so every payload is verified server-side with the provider before any
 * state changes. It must be registered before the authenticated
 * /:id routes would... (express matches in registration order; the static
 * segment "ipn" does not collide with ":id" paths of a different prefix —
 * see the distinct path strings below).
 */
const router = express.Router();

const write = [
  requireAuth,
  requireBusinessContext(),
  requireFullAccess,
] as const;

// Public gateway callback (no auth — see controller doc).
router.post(
  "/api/sales/payment-intents/ipn",
  ipnRateLimit,
  saleIntentsController.paymentIpn,
);

router.post(
  "/api/sales/:saleId/payment-intents",
  ...write,
  requirePermission("pos.create_sale"),
  saleIntentsController.createIntent,
);

// Verify by gateway tran_id — the provider redirect carries val_id +
// tran_id but not our intent id (used by the POS return-handler page).
router.post(
  "/api/sales/payment-intents/verify",
  ...write,
  requirePermission("pos.create_sale"),
  saleIntentsController.verifyIntentByTranId,
);

router.post(
  "/api/sales/payment-intents/:id/verify",
  ...write,
  requirePermission("pos.create_sale"),
  saleIntentsController.verifyIntent,
);

router.post(
  "/api/sales/payment-intents/:id/cancel",
  ...write,
  requirePermission("pos.create_sale"),
  saleIntentsController.cancelIntent,
);

export default router;
