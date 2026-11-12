import express from "express";
import * as controller from "./quotations.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();

const read = [requireAuth, requireBusinessContext()] as const;
const write = [
  ...read,
  requireLocationAccess(),
  requireFullAccess,
] as const;

router.get(
  "/api/quotations",
  ...read,
  requirePermission("quotations.view"),
  controller.getQuotations,
);
router.get(
  "/api/quotations/:quotationId",
  ...read,
  requirePermission("quotations.view"),
  controller.getQuotation,
);
router.post(
  "/api/quotations",
  ...write,
  requirePermission("quotations.create"),
  controller.postQuotation,
);
router.patch(
  "/api/quotations/:quotationId",
  ...write,
  requirePermission("quotations.create"),
  controller.patchQuotation,
);
router.post(
  "/api/quotations/:quotationId/status",
  ...write,
  requirePermission("quotations.create"),
  controller.postTransition,
);
// Conversion creates a sale — the dedicated convert permission.
router.post(
  "/api/quotations/:quotationId/convert",
  ...write,
  requirePermission("quotations.convert"),
  controller.postConvert,
);

export default router;
