import express from "express";
import * as warrantyController from "./warranty.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();

// Same chain as the expenses module: business context from the
// X-Business-Id header, location from X-Location-Id (or the business
// default), then the per-route permission key.
const read = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
] as const;
const write = [...read, requireFullAccess] as const;

// ---------------------------------------------------------------------------
// Product/variant warranty configuration — static segments before /:id.
// ---------------------------------------------------------------------------
router.get(
  "/api/products/:productId/warranty-config",
  ...read,
  requirePermission("warranty.config.manage"),
  warrantyController.getProductWarrantyConfig,
);
router.put(
  "/api/products/:productId/warranty-config",
  ...write,
  requirePermission("warranty.config.manage"),
  warrantyController.putProductWarrantyConfig,
);
router.put(
  "/api/products/:productId/variants/:variantId/warranty-config",
  ...write,
  requirePermission("warranty.config.manage"),
  warrantyController.putVariantWarrantyConfig,
);
router.delete(
  "/api/products/:productId/variants/:variantId/warranty-config",
  ...write,
  requirePermission("warranty.config.manage"),
  warrantyController.deleteVariantWarrantyConfig,
);

// ---------------------------------------------------------------------------
// Warranty registry — /lookup and /certificate are static segments and must
// be registered before /:id.
// ---------------------------------------------------------------------------
router.get(
  "/api/warranties",
  ...read,
  requirePermission("warranty.view"),
  warrantyController.getWarranties,
);
router.get(
  "/api/warranties/lookup",
  ...read,
  requirePermission("warranty.view"),
  warrantyController.lookupWarranties,
);
router.get(
  "/api/warranties/:id",
  ...read,
  requirePermission("warranty.view"),
  warrantyController.getWarranty,
);
router.get(
  "/api/warranties/:id/certificate",
  ...read,
  requirePermission("warranty.view"),
  warrantyController.getWarrantyCertificate,
);

// ---------------------------------------------------------------------------
// Warranty claims
// ---------------------------------------------------------------------------
router.post(
  "/api/warranty-claims",
  ...write,
  requirePermission("warranty.claim.create"),
  warrantyController.createWarrantyClaim,
);
router.get(
  "/api/warranty-claims",
  ...read,
  requirePermission("warranty.view"),
  warrantyController.getWarrantyClaims,
);
router.get(
  "/api/warranty-claims/:id",
  ...read,
  requirePermission("warranty.view"),
  warrantyController.getWarrantyClaim,
);

// Lifecycle actions: creation/inspection are claim.create; state moves that
// decide outcomes are claim.manage; closing/cancelling is claim.close.
router.post(
  "/api/warranty-claims/:id/inspection",
  ...write,
  requirePermission("warranty.claim.manage"),
  warrantyController.inspectWarrantyClaim,
);
router.post(
  "/api/warranty-claims/:id/approve",
  ...write,
  requirePermission("warranty.claim.manage"),
  warrantyController.approveWarrantyClaim,
);
router.post(
  "/api/warranty-claims/:id/reject",
  ...write,
  requirePermission("warranty.claim.manage"),
  warrantyController.rejectWarrantyClaim,
);
router.post(
  "/api/warranty-claims/:id/repair",
  ...write,
  requirePermission("warranty.claim.manage"),
  warrantyController.updateWarrantyClaimRepair,
);
router.post(
  "/api/warranty-claims/:id/assign",
  ...write,
  requirePermission("warranty.claim.manage"),
  warrantyController.assignWarrantyClaim,
);
router.post(
  "/api/warranty-claims/:id/ready",
  ...write,
  requirePermission("warranty.claim.manage"),
  warrantyController.readyWarrantyClaim,
);
router.post(
  "/api/warranty-claims/:id/pickup",
  ...write,
  requirePermission("warranty.claim.manage"),
  warrantyController.pickupWarrantyClaim,
);
router.post(
  "/api/warranty-claims/:id/replacement",
  ...write,
  requirePermission("warranty.claim.manage"),
  warrantyController.replaceWarrantyClaim,
);
router.post(
  "/api/warranty-claims/:id/notes",
  ...write,
  requirePermission("warranty.view"),
  warrantyController.noteWarrantyClaim,
);
router.post(
  "/api/warranty-claims/:id/close",
  ...write,
  requirePermission("warranty.claim.close"),
  warrantyController.closeWarrantyClaim,
);
router.post(
  "/api/warranty-claims/:id/cancel",
  ...write,
  requirePermission("warranty.claim.close"),
  warrantyController.cancelWarrantyClaim,
);

// ---------------------------------------------------------------------------
// Supplier warranties (separate subsystem — warranty.supplier.*)
// ---------------------------------------------------------------------------
router.get(
  "/api/supplier-warranties",
  ...read,
  requirePermission("warranty.supplier.view"),
  warrantyController.getSupplierWarranties,
);
router.post(
  "/api/supplier-warranties",
  ...write,
  requirePermission("warranty.supplier.manage"),
  warrantyController.createSupplierWarranty,
);
router.get(
  "/api/supplier-warranty-claims",
  ...read,
  requirePermission("warranty.supplier.view"),
  warrantyController.getSupplierClaims,
);
router.post(
  "/api/supplier-warranty-claims",
  ...write,
  requirePermission("warranty.supplier.manage"),
  warrantyController.createSupplierClaim,
);
router.get(
  "/api/supplier-warranty-claims/:id",
  ...read,
  requirePermission("warranty.supplier.view"),
  warrantyController.getSupplierClaim,
);
router.post(
  "/api/supplier-warranty-claims/:id/response",
  ...write,
  requirePermission("warranty.supplier.manage"),
  warrantyController.respondSupplierClaim,
);
router.post(
  "/api/supplier-warranty-claims/:id/replacement",
  ...write,
  requirePermission("warranty.supplier.manage"),
  warrantyController.replaceSupplierClaim,
);
router.post(
  "/api/supplier-warranty-claims/:id/recovery",
  ...write,
  requirePermission("warranty.supplier.manage"),
  warrantyController.recoverSupplierClaim,
);
router.post(
  "/api/supplier-warranty-claims/:id/notes",
  ...write,
  requirePermission("warranty.supplier.view"),
  warrantyController.noteSupplierClaim,
);
router.post(
  "/api/supplier-warranty-claims/:id/close",
  ...write,
  requirePermission("warranty.supplier.manage"),
  warrantyController.closeSupplierClaim,
);
router.post(
  "/api/supplier-warranty-claims/:id/cancel",
  ...write,
  requirePermission("warranty.supplier.manage"),
  warrantyController.cancelSupplierClaim,
);

// ---------------------------------------------------------------------------
// Overview + reports
// ---------------------------------------------------------------------------
router.get(
  "/api/warranty-overview",
  ...read,
  requirePermission("warranty.view"),
  warrantyController.getWarrantyOverview,
);
router.get(
  "/api/reports/warranty/expiry",
  ...read,
  requirePermission("warranty.reports.view"),
  warrantyController.getWarrantyExpiryReport,
);
router.get(
  "/api/reports/warranty/claims",
  ...read,
  requirePermission("warranty.reports.view"),
  warrantyController.getWarrantyClaimsReport,
);
router.get(
  "/api/reports/warranty/costs",
  ...read,
  requirePermission("warranty.reports.view"),
  warrantyController.getWarrantyCostsReport,
);
router.get(
  "/api/reports/warranty/supplier",
  ...read,
  requirePermission("warranty.reports.view"),
  warrantyController.getWarrantySupplierReport,
);

export default router;
