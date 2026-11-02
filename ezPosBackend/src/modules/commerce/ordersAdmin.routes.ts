import express from "express";
import * as ordersAdminController from "./ordersAdmin.controller.js";
import * as dataExportController from "./dataExport.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessAccess,
  requireFullAccess,
} from "../../middleware/business.js";

const router = express.Router();

// Unified order management — reads stay available in read-only mode;
// fulfillment and payment actions mutate.
const read = [requireAuth, requireBusinessAccess()] as const;
const write = [...read, requireFullAccess] as const;

router.get(
  "/api/businesses/:businessId/orders",
  ...read,
  ordersAdminController.getOrders,
);
router.get(
  "/api/businesses/:businessId/export",
  ...read,
  dataExportController.exportBusinessData,
);
router.get(
  "/api/businesses/:businessId/orders/:orderId",
  ...read,
  ordersAdminController.getOrder,
);
router.post(
  "/api/businesses/:businessId/orders/:orderId/fulfillment",
  ...write,
  ordersAdminController.setFulfillmentStatus,
);
router.post(
  "/api/businesses/:businessId/orders/:orderId/mark-paid",
  ...write,
  ordersAdminController.markPaid,
);

export default router;
