import express from "express";
import * as documentSettingsController from "./documentSettings.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusinessContext, requireFullAccess } from "../../middleware/business.js";
import {
  requireAnyPermission,
  requirePermission,
} from "../../middleware/permissions.js";

const router = express.Router();

// Business-scoped document template settings (receipt & invoice
// customization). Reading stays available to every selling role (cashiers
// print with the active template); editing is its own permission so only
// owners/managers can change what the whole business prints.
const read = [requireAuth, requireBusinessContext()];
const write = [...read, requireFullAccess];

router.get(
  "/api/document-settings",
  ...read,
  requireAnyPermission(["receipt_settings.view", "pos.view", "sales.view"]),
  documentSettingsController.getDocumentSettingsController,
);

router.put(
  "/api/document-settings/:docType",
  ...write,
  requirePermission("receipt_settings.edit"),
  documentSettingsController.updateDocumentSettingsController,
);

export default router;
