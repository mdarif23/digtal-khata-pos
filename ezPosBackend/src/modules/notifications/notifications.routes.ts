import express from "express";
import * as notificationsController from "./notifications.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusinessAccess } from "../../middleware/business.js";

const router = express.Router();
const read = [requireAuth, requireBusinessAccess()] as const;

router.get(
  "/api/businesses/:businessId/notifications",
  ...read,
  notificationsController.getNotifications,
);
router.post(
  "/api/businesses/:businessId/notifications/read-all",
  ...read,
  notificationsController.readAll,
);
router.post(
  "/api/businesses/:businessId/notifications/:notificationId/read",
  ...read,
  notificationsController.readOne,
);

export default router;
