import express from "express";
import * as barcodesController from "./barcodes.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusinessContext, requireFullAccess } from "../../middleware/business.js";
import { requirePermission, requireAnyPermission } from "../../middleware/permissions.js";

const router = express.Router();

// Barcodes are business-scoped (products have no location); the generator
// page and lookups ride products.view, POS scan fallbacks ride pos.view.
const read = [
  requireAuth,
  requireBusinessContext(),
  requireAnyPermission(["products.view", "pos.view"]),
] as const;
const write = [
  ...read,
  requireFullAccess,
  requirePermission("products.edit"),
] as const;
const print = [
  ...read,
  requireFullAccess,
  requirePermission("products.print_labels"),
] as const;

// Generator page catalog (paged, filterable).
router.get("/api/barcodes/search", ...read, barcodesController.getBarcodeSearch);
// Variant detail incl. aliases.
router.get("/api/barcodes/variant/:variantId", ...read, barcodesController.getVariant);
// Bulk internal generation (explicit regenerate flow).
router.post("/api/barcodes/generate", ...write, barcodesController.postGenerate);
// Assign primary (replace confirmed) or add alias.
router.post("/api/barcodes/assign", ...write, barcodesController.postAssign);
// Alias management.
router.put("/api/barcodes/alias/:aliasId", ...write, barcodesController.patchAlias);
router.delete("/api/barcodes/alias/:aliasId", ...write, barcodesController.deleteAliasHandler);
// Live validation (format, check digit, in-business conflicts).
router.post("/api/barcodes/validate", ...read, barcodesController.postValidate);
// Exact scanner resolution: primary → alias → SKU; never ambiguous picks.
router.get("/api/barcodes/lookup/:code", ...read, barcodesController.getLookup);
// Print history (audit-backed) + job logging.
router.get("/api/barcodes/print-history", ...read, barcodesController.getPrintHistoryHandler);
router.post("/api/barcodes/print-history", ...print, barcodesController.postPrintLog);

export default router;
