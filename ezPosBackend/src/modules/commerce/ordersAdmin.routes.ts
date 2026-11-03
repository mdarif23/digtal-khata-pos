import express from "express";
import * as ordersAdminController from "./ordersAdmin.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessAccess,
  requireFullAccess,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();

// Unified order management — reads stay available in read-only mode;
// fulfillment and payment actions mutate. Every route is permission-gated
// (module two §11); the frontend nav is cosmetic only.
const read = [requireAuth, requireBusinessAccess()] as const;
const write = [...read, requireFullAccess] as const;
const orderId = "/api/businesses/:businessId/orders/:orderId";

router.get(
  "/api/businesses/:businessId/orders",
  ...read,
  requirePermission("orders.view"),
  ordersAdminController.getOrders,
);
// Registered BEFORE /orders/:orderId so "summary" is not parsed as an id.
router.get(
  "/api/businesses/:businessId/orders/summary",
  ...read,
  requirePermission("orders.view"),
  ordersAdminController.getOrderSummary,
);
router.get(
  "/api/businesses/:businessId/orders/:orderId",
  ...read,
  requirePermission("orders.view"),
  ordersAdminController.getOrder,
);
router.post(
  `${orderId}/fulfillment`,
  ...write,
  requirePermission("orders.process"),
  ordersAdminController.setFulfillmentStatus,
);
router.post(
  `${orderId}/mark-paid`,
  ...write,
  requirePermission("orders.mark_paid"),
  ordersAdminController.markPaid,
);

// Workflow (module two §6)
router.post(`${orderId}/confirm`, ...write, requirePermission("orders.confirm"), ordersAdminController.confirmOrder);
router.post(
  `${orderId}/start-processing`,
  ...write,
  requirePermission("orders.process"),
  ordersAdminController.startProcessing,
);
router.post(`${orderId}/cancel`, ...write, requirePermission("orders.cancel"), ordersAdminController.cancelOrder);
router.get(`${orderId}/timeline`, ...read, requirePermission("orders.view"), ordersAdminController.getTimeline);
router.get(
  `${orderId}/fulfillment`,
  ...read,
  requirePermission("orders.view"),
  ordersAdminController.getFulfillment,
);
router.get(
  `${orderId}/packaging-defaults`,
  ...read,
  requirePermission("orders.view"),
  ordersAdminController.getPackagingDefaults,
);
router.post(
  `${orderId}/packages`,
  ...write,
  requirePermission("orders.pack"),
  ordersAdminController.createPackage,
);
router.patch(
  `${orderId}/packages/:packageId`,
  ...write,
  requirePermission("orders.pack"),
  ordersAdminController.patchPackage,
);
router.delete(
  `${orderId}/packages/:packageId`,
  ...write,
  requirePermission("orders.pack"),
  ordersAdminController.removePackage,
);
router.post(
  `${orderId}/ready-to-ship`,
  ...write,
  requirePermission("orders.ready_to_ship"),
  ordersAdminController.readyToShip,
);
router.post(`${orderId}/ship`, ...write, requirePermission("orders.ship"), ordersAdminController.ship);
router.patch(
  `${orderId}/shipment`,
  ...write,
  requirePermission("orders.manage_shipping"),
  ordersAdminController.patchShipment,
);
router.post(`${orderId}/deliver`, ...write, requirePermission("orders.deliver"), ordersAdminController.deliver);

export default router;
