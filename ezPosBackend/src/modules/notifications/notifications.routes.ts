import express from "express";
import * as notificationsController from "./notifications.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusinessContext } from "../../middleware/business.js";

/**
 * Notification center (Module 14): in-app delivery for every signed-in
 * member of the business; read state and muting are per user.
 */
const router = express.Router();

const stack = [requireAuth, requireBusinessContext()] as const;

router.get("/api/notifications", ...stack, notificationsController.list);
router.get("/api/notifications/unread-count", ...stack, notificationsController.unread);
router.post("/api/notifications/read", ...stack, notificationsController.markRead);
router.post("/api/notifications/read-all", ...stack, notificationsController.markAllRead);
router.get("/api/notifications/prefs", ...stack, notificationsController.getPrefs);
router.post("/api/notifications/prefs", ...stack, notificationsController.setPref);

export default router;
