import express from "express";
import * as webhooksController from "./webhookEndpoints.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessAccess,
  requireFullAccess,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();

// K3-002: webhook endpoints are an exfiltration channel (the business's
// order data POSTed to an arbitrary URL) and a server-side-fetch vector —
// "owner workflows, full access" alone let ANY active member create,
// delete, or fire test deliveries. settings.edit is the authority now.
const portal = [
  requireAuth,
  requireBusinessAccess(),
  requireFullAccess,
  requirePermission("settings.edit"),
] as const;

router.post(
  "/api/businesses/:businessId/webhooks",
  ...portal,
  webhooksController.createWebhookEndpoint,
);
router.get(
  "/api/businesses/:businessId/webhooks",
  ...portal,
  webhooksController.getWebhookEndpoints,
);
router.delete(
  "/api/businesses/:businessId/webhooks/:endpointId",
  ...portal,
  webhooksController.removeWebhookEndpoint,
);
router.get(
  "/api/businesses/:businessId/webhooks/:endpointId/deliveries",
  // L3-002: the deliveries (order-event payloads) were readable even in
  // read-only mode — full portal access required like every sibling.
  requireAuth,
  requireBusinessAccess(),
  requireFullAccess,
  requirePermission("settings.edit"),
  webhooksController.getWebhookDeliveries,
);
router.post(
  "/api/businesses/:businessId/webhooks/:endpointId/test",
  ...portal,
  webhooksController.testWebhookEndpoint,
);

export default router;
