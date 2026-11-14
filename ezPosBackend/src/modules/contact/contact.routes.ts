import express from "express";
import * as contactController from "./contact.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
// Location-aware: the X-Location-Id header (or the business default) is
// validated against membership + assignment before any handler runs.
const read = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
] as const;
const write = [...read, requireFullAccess] as const;

router.get(
  "/api/contacts/suppliers",
  ...read,
  requirePermission("suppliers.view"),
  contactController.getSuppliers,
);
router.post(
  "/api/contacts/supplier",
  ...write,
  requirePermission("suppliers.create"),
  contactController.createSupplier,
);
// D1-05: supplier contact details were permanently uncorrectable.
router.put(
  "/api/contacts/supplier/:supplierId",
  ...write,
  requirePermission("suppliers.edit"),
  contactController.updateSupplier,
);
export default router;
